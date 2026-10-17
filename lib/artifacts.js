// Durable artifacts for captures and recordings, plus the image-attachment path.
import fs from 'node:fs/promises';
import path from 'node:path';

const MEDIA_TYPES = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg' };

/** Keep one path segment safe: session ids and prefixes come from trusted code, but be strict. */
function safeSegment(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
  return cleaned.length > 0 ? cleaned : 'shared';
}

function stamp() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
}

export class Artifacts {
  #root;
  #dirs = new Map();
  #counter = 0;

  constructor(root) {
    this.#root = root;
  }

  get root() {
    return this.#root;
  }

  /** The per-session directory, created on first use. */
  async dirFor(sessionKey) {
    const key = safeSegment(sessionKey ?? 'shared');
    const cached = this.#dirs.get(key);
    if (cached) return cached;
    const dir = path.join(this.#root, key);
    await fs.mkdir(dir, { recursive: true });
    this.#dirs.set(key, dir);
    return dir;
  }

  /** A fresh, collision-free path inside one session's directory. */
  async nextPath(sessionKey, prefix, extension) {
    const dir = await this.dirFor(sessionKey);
    this.#counter += 1;
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    return path.join(dir, `${safeSegment(prefix)}-${stamp()}-${this.#counter}${ext}`);
  }

  async readBytes(filePath) {
    return fs.readFile(filePath);
  }

  async writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}

export function mediaTypeFor(format) {
  return MEDIA_TYPES[String(format).toLowerCase()] ?? 'image/png';
}

/**
 * Decide whether the calling route can accept an image, mirroring the gate the
 * shipped `read_image` tool applies: the resolved route must declare `image`
 * input. Returns a reason when it cannot, so callers can explain the omission.
 */
export async function imageRouteStatus(ctx, exec) {
  const attachments = ctx.get('attachments');
  if (!attachments) return { ok: false, reason: 'no attachment service is mounted in this composition' };
  const llm = ctx.get('llm');
  if (!llm) return { ok: false, reason: 'no llm service is mounted, so the model route cannot be resolved' };
  const routed = exec.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec.agent?.options?.provider;
  const model = routed?.model ?? exec.agent?.options?.model;
  if (!provider || !model) return { ok: false, reason: 'the current model route could not be resolved' };
  try {
    const active = await llm.resolveModelInfo(provider, model, exec.signal);
    if (!Array.isArray(active?.inputModalities) || !active.inputModalities.includes('image')) {
      return { ok: false, reason: `model "${model}" does not declare image input` };
    }
    return { ok: true, attachments, model };
  } catch (error) {
    return { ok: false, reason: `the model route could not be inspected: ${error.message}` };
  }
}

/**
 * Commit one capture as a durable image attachment.
 * Returns `{ attachment }` or `{ skipped }`; never throws for a policy reason,
 * because the file on disk is always a usable result on its own.
 */
export async function attachCapture(ctx, exec, cfg, { path: filePath, format, width, height }) {
  if (cfg.attachImages === 'never') return { skipped: 'attachImages is set to never' };
  const status = await imageRouteStatus(ctx, exec);
  if (!status.ok) {
    return { skipped: cfg.attachImages === 'always' ? `the image cannot be attached: ${status.reason}` : status.reason };
  }
  let data;
  try {
    data = await fs.readFile(filePath);
  } catch (error) {
    return { skipped: `the capture could not be re-read for attachment: ${error.message}` };
  }
  const mediaType = mediaTypeFor(format);
  try {
    const ref = await status.attachments.saveImage({
      data,
      mediaType,
      name: filePath.split(/[\\/]/).pop(),
    });
    return {
      attachment: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
        ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
      },
      storedWidth: ref.width,
      storedHeight: ref.height,
    };
  } catch (error) {
    return { skipped: `the image was captured but not attached: ${error.message}` };
  }
}
