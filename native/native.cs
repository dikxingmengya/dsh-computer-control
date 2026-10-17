// DSH computer-control native layer.
// Compiled once by Add-Type inside the resident PowerShell helper process.
// Target: C# 5 / .NET Framework 4.x as shipped with Windows PowerShell 5.1
//          (no string interpolation, no expression-bodied members, no out-var).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DshNat
{
	// ---------------------------------------------------------------- P/Invoke
	[DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
	[DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int awareness);
	[DllImport("user32.dll")] static extern bool SetProcessDPIAware();
	[DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr hmon, int dpiType, out uint dpiX, out uint dpiY);
	[DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
	[DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
	[DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int dx, int dy, int w, int h, IntPtr src, int sx, int sy, int rop);
	[DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr hdc, int x, int y);
	[DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
	[DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
	[DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hmon, ref MONITORINFOEX info);
	[DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

	delegate bool MonitorEnumProc(IntPtr hmon, IntPtr hdc, ref RECT rect, IntPtr data);

	[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
	[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	struct MONITORINFOEX
	{
		public int cbSize;
		public RECT rcMonitor;
		public RECT rcWork;
		public uint dwFlags;
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
	}

	const int SRCCOPY = 0x00CC0020;
	const int CAPTUREBLT = 0x40000000;
	const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
	const int SM_CMONITORS = 80;
	const uint MONITORINFOF_PRIMARY = 1;
	const int MDT_EFFECTIVE_DPI = 0;
	const int PW_RENDERFULLCONTENT = 2;

	static string dpiMode = "unknown";

	/// <summary>Declare per-monitor-v2 DPI awareness. MUST run before any UI call,
	/// otherwise every metric and cursor coordinate is virtualized and clicks land wrong.</summary>
	public static string Init()
	{
		try
		{
			if (SetProcessDpiAwarenessContext(new IntPtr(-4))) { dpiMode = "per-monitor-v2"; return dpiMode; }
		}
		catch { }
		try
		{
			if (SetProcessDpiAwareness(2) == 0) { dpiMode = "per-monitor"; return dpiMode; }
		}
		catch { }
		try
		{
			if (SetProcessDPIAware()) { dpiMode = "system"; return dpiMode; }
		}
		catch { }
		dpiMode = "unaware";
		return dpiMode;
	}

	public static string DpiMode() { return dpiMode; }

	// ------------------------------------------------------------- geometry
	public static Dictionary<string, object> VirtualScreen()
	{
		Dictionary<string, object> d = new Dictionary<string, object>();
		int x = GetSystemMetrics(SM_XVIRTUALSCREEN), y = GetSystemMetrics(SM_YVIRTUALSCREEN);
		int w = GetSystemMetrics(SM_CXVIRTUALSCREEN), h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
		d["x"] = x; d["y"] = y; d["width"] = w; d["height"] = h;
		d["monitors"] = GetSystemMetrics(SM_CMONITORS);
		return d;
	}

	public static List<object> Monitors()
	{
		List<object> list = new List<object>();
		int index = 0;
		MonitorEnumProc cb = delegate(IntPtr hmon, IntPtr hdc, ref RECT r, IntPtr data)
		{
			MONITORINFOEX mi = new MONITORINFOEX();
			mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
			if (!GetMonitorInfo(hmon, ref mi)) return true;
			Dictionary<string, object> d = new Dictionary<string, object>();
			uint dx = 0, dy = 0;
			try { GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, out dx, out dy); } catch { }
			d["index"] = index;
			d["device"] = mi.szDevice == null ? "" : mi.szDevice.TrimEnd('\0');
			d["primary"] = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;
			d["x"] = mi.rcMonitor.Left; d["y"] = mi.rcMonitor.Top;
			d["width"] = mi.rcMonitor.Right - mi.rcMonitor.Left;
			d["height"] = mi.rcMonitor.Bottom - mi.rcMonitor.Top;
			d["workX"] = mi.rcWork.Left; d["workY"] = mi.rcWork.Top;
			d["workWidth"] = mi.rcWork.Right - mi.rcWork.Left;
			d["workHeight"] = mi.rcWork.Bottom - mi.rcWork.Top;
			d["dpiX"] = (int)dx; d["dpiY"] = (int)dy;
			d["scale"] = dx == 0 ? 1.0 : Math.Round(dx / 96.0, 4);
			list.Add(d);
			index++;
			return true;
		};
		EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
		return list;
	}

	public static Dictionary<string, object> CursorPos()
	{
		POINT p;
		GetCursorPos(out p);
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["x"] = p.X; d["y"] = p.Y;
		return d;
	}

	// ------------------------------------------------------------- capture
	static Bitmap BitBltRegion(int x, int y, int w, int h)
	{
		if (w <= 0 || h <= 0) throw new ArgumentException("capture region has no area: " + w + "x" + h);
		Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
		using (Graphics g = Graphics.FromImage(bmp))
		{
			IntPtr dst = g.GetHdc();
			IntPtr src = GetDC(IntPtr.Zero);
			try
			{
				if (!BitBlt(dst, 0, 0, w, h, src, x, y, SRCCOPY | CAPTUREBLT))
					throw new InvalidOperationException("BitBlt failed with win32 error " + Marshal.GetLastWin32Error());
			}
			finally
			{
				ReleaseDC(IntPtr.Zero, src);
				g.ReleaseHdc(dst);
			}
		}
		return bmp;
	}

	/// <summary>Fraction of sampled pixels that are pure black; PrintWindow on a
	/// hardware-accelerated window silently succeeds while painting nothing.</summary>
	static double BlackRatio(Bitmap bmp)
	{
		BitmapData bd = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
		try
		{
			int stride = bd.Stride, w = bmp.Width, h = bmp.Height;
			byte[] row = new byte[stride];
			int total = 0, black = 0;
			int stepY = Math.Max(1, h / 40), stepX = Math.Max(1, w / 40);
			for (int y = 0; y < h; y += stepY)
			{
				Marshal.Copy(new IntPtr(bd.Scan0.ToInt64() + (long)y * stride), row, 0, stride);
				for (int x = 0; x < w; x += stepX)
				{
					int o = x * 4;
					total++;
					if (row[o] < 8 && row[o + 1] < 8 && row[o + 2] < 8) black++;
				}
			}
			return total == 0 ? 1.0 : (double)black / total;
		}
		finally { bmp.UnlockBits(bd); }
	}

	static Bitmap PrintWindowCapture(IntPtr hwnd, int w, int h)
	{
		if (w <= 0 || h <= 0) throw new ArgumentException("window has no area: " + w + "x" + h);
		Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
		using (Graphics g = Graphics.FromImage(bmp))
		{
			IntPtr dst = g.GetHdc();
			try { PrintWindow(hwnd, dst, PW_RENDERFULLCONTENT); }
			finally { g.ReleaseHdc(dst); }
		}
		return bmp;
	}

	static Bitmap ScaleBitmap(Bitmap src, double factor)
	{
		int nw = Math.Max(1, (int)Math.Round(src.Width * factor));
		int nh = Math.Max(1, (int)Math.Round(src.Height * factor));
		if (nw == src.Width && nh == src.Height) return src;
		Bitmap dst = new Bitmap(nw, nh, PixelFormat.Format32bppArgb);
		using (Graphics g = Graphics.FromImage(dst))
		{
			g.InterpolationMode = InterpolationMode.HighQualityBicubic;
			g.PixelOffsetMode = PixelOffsetMode.HighQuality;
			g.SmoothingMode = SmoothingMode.HighQuality;
			g.DrawImage(src, new Rectangle(0, 0, nw, nh), 0, 0, src.Width, src.Height, GraphicsUnit.Pixel);
		}
		src.Dispose();
		return dst;
	}

	static void SaveBitmap(Bitmap bmp, string path, string format, int quality)
	{
		string dir = Path.GetDirectoryName(path);
		if (dir != null && dir.Length > 0 && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
		if (format == "jpeg" || format == "jpg")
		{
			ImageCodecInfo codec = null;
			foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
				if (c.FormatID == ImageFormat.Jpeg.Guid) codec = c;
			EncoderParameters ps = new EncoderParameters(1);
			ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
			if (codec != null) bmp.Save(path, codec, ps); else bmp.Save(path, ImageFormat.Jpeg);
		}
		else bmp.Save(path, ImageFormat.Png);
	}

	/// <summary>Capture a screen rectangle, a monitor, the virtual desktop, or a window,
	/// optionally downscaling, and write it to disk. Returns geometry actually written.</summary>
	public static Dictionary<string, object> Capture(
		int x, int y, int w, int h,
		string hwndHex, int maxDim, double scale, string format, int quality, string outPath)
	{
		Bitmap bmp = null;
		string source = "screen";
		if (hwndHex != null && hwndHex.Length > 0)
		{
			IntPtr hwnd = new IntPtr(Convert.ToInt64(hwndHex, 16));
			bmp = PrintWindowCapture(hwnd, w, h);
			source = "printwindow";
			if (BlackRatio(bmp) > 0.995)
			{
				bmp.Dispose();
				bmp = BitBltRegion(x, y, w, h);
				source = "bitblt-fallback";
			}
		}
		else
		{
			bmp = BitBltRegion(x, y, w, h);
		}

		int ow = bmp.Width, oh = bmp.Height;
		double f = 1.0;
		if (scale > 0 && scale < 1.0) f = scale;
		if (maxDim > 0)
		{
			double byDim = (double)maxDim / Math.Max(bmp.Width, bmp.Height);
			if (byDim < f) f = byDim;
		}
		if (f < 1.0) bmp = ScaleBitmap(bmp, f);

		SaveBitmap(bmp, outPath, format, quality);
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["path"] = outPath;
		d["source"] = source;
		d["originX"] = x; d["originY"] = y;
		d["screenWidth"] = ow; d["screenHeight"] = oh;
		d["width"] = bmp.Width; d["height"] = bmp.Height;
		d["scaleToScreen"] = ow == 0 ? 1.0 : Math.Round((double)ow / bmp.Width, 6);
		d["bytes"] = new FileInfo(outPath).Length;
		d["format"] = (format == "jpeg" || format == "jpg") ? "jpeg" : "png";
		bmp.Dispose();
		return d;
	}

	// ------------------------------------------------------------- pixels
	static Color PixelAt(int x, int y)
	{
		IntPtr dc = GetDC(IntPtr.Zero);
		try
		{
			uint v = GetPixel(dc, x, y);
			if (v == 0xFFFFFFFF) throw new InvalidOperationException("GetPixel failed at " + x + "," + y);
			return Color.FromArgb((int)(v & 0xFF), (int)((v >> 8) & 0xFF), (int)((v >> 16) & 0xFF));
		}
		finally { ReleaseDC(IntPtr.Zero, dc); }
	}

	public static Dictionary<string, object> Pixel(int x, int y)
	{
		Color c = PixelAt(x, y);
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["x"] = x; d["y"] = y;
		d["r"] = c.R; d["g"] = c.G; d["b"] = c.B;
		d["hex"] = string.Format("#{0:X2}{1:X2}{2:X2}", c.R, c.G, c.B);
		return d;
	}

	static byte[] GrayFrom(Bitmap bmp, out int w, out int h)
	{
		w = bmp.Width; h = bmp.Height;
		byte[] gray = new byte[w * h];
		BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
		try
		{
			int stride = bd.Stride;
			byte[] row = new byte[stride];
			for (int y = 0; y < h; y++)
			{
				Marshal.Copy(new IntPtr(bd.Scan0.ToInt64() + (long)y * stride), row, 0, stride);
				int o = y * w;
				for (int x = 0; x < w; x++)
				{
					int p = x * 4;
					gray[o + x] = (byte)((row[p] * 29 + row[p + 1] * 150 + row[p + 2] * 77) >> 8);
				}
			}
		}
		finally { bmp.UnlockBits(bd); }
		return gray;
	}

	static int[] RgbFrom(Bitmap bmp)
	{
		int w = bmp.Width, h = bmp.Height;
		int[] rgb = new int[w * h];
		BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
		try
		{
			int stride = bd.Stride;
			byte[] row = new byte[stride];
			for (int y = 0; y < h; y++)
			{
				Marshal.Copy(new IntPtr(bd.Scan0.ToInt64() + (long)y * stride), row, 0, stride);
				int o = y * w;
				for (int x = 0; x < w; x++)
				{
					int p = x * 4;
					rgb[o + x] = (row[p + 2] << 16) | (row[p + 1] << 8) | row[p];
				}
			}
		}
		finally { bmp.UnlockBits(bd); }
		return rgb;
	}

	/// <summary>Scan a region for pixels within per-channel tolerance of an RGB target.
	/// Returns the first match in scan order plus the total match count.</summary>
	public static Dictionary<string, object> FindColor(int x, int y, int w, int h, int r, int g, int b, int tolerance, int step, int maxResults)
	{
		if (step < 1) step = 1;
		Bitmap bmp = BitBltRegion(x, y, w, h);
		List<object> hits = new List<object>();
		int count = 0;
		try
		{
			int[] rgb = RgbFrom(bmp);
			for (int yy = 0; yy < h; yy += step)
			{
				for (int xx = 0; xx < w; xx += step)
				{
					int v = rgb[yy * w + xx];
					int pr = (v >> 16) & 0xFF, pg = (v >> 8) & 0xFF, pb = v & 0xFF;
					if (Math.Abs(pr - r) <= tolerance && Math.Abs(pg - g) <= tolerance && Math.Abs(pb - b) <= tolerance)
					{
						count++;
						if (hits.Count < maxResults)
						{
							Dictionary<string, object> hit = new Dictionary<string, object>();
							hit["x"] = x + xx; hit["y"] = y + yy;
							hit["r"] = pr; hit["g"] = pg; hit["b"] = pb;
							hits.Add(hit);
						}
					}
				}
			}
		}
		finally { bmp.Dispose(); }
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["found"] = hits.Count > 0;
		d["count"] = count;
		d["matches"] = hits;
		d["target"] = string.Format("#{0:X2}{1:X2}{2:X2}", r, g, b);
		return d;
	}

	// ------------------------------------------------------------- template match
	sealed class Cand
	{
		public int X, Y;
		public double Score;
		public Cand(int x, int y, double s) { X = x; Y = y; Score = s; }
	}

	/// <summary>Score every placement of the needle inside the haystack at one pyramid
	/// level. Score is the fraction of pixels within <paramref name="tol"/> gray levels.</summary>
	static void ScoreLevel(byte[] hay, int hw, int hh, byte[] ndl, int nw, int nh,
		int tol, double floor, int step, int ox, int oy, double levelScale, List<Cand> outp, int keep)
	{
		if (nw > hw || nh > hh) return;
		int total = nw * nh;
		for (int y = 0; y + nh <= hh; y += step)
		{
			for (int x = 0; x + nw <= hw; x += step)
			{
				int good = 0;
				bool dead = false;
				for (int ty = 0; ty < nh && !dead; ty++)
				{
					int ho = (y + ty) * hw + x;
					int no = ty * nw;
					for (int tx = 0; tx < nw; tx++)
					{
						int diff = hay[ho + tx] - ndl[no + tx];
						if (diff < 0) diff = -diff;
						if (diff <= tol) good++;
						else if (good + (total - (ty * nw + tx + 1)) < floor * total) { dead = true; break; }
					}
				}
				double score = (double)good / total;
				if (score >= floor)
				{
					Cand c = new Cand(
						ox + (int)Math.Round(x / levelScale),
						oy + (int)Math.Round(y / levelScale),
						score);
					outp.Add(c);
				}
			}
		}
		if (outp.Count > keep)
		{
			outp.Sort(delegate(Cand a, Cand b) { return b.Score.CompareTo(a.Score); });
			outp.RemoveRange(keep, outp.Count - keep);
		}
	}

	static List<Cand> Dedupe(List<Cand> src, int radius, int keep)
	{
		List<Cand> sorted = new List<Cand>(src);
		// Score first, then a fixed spatial order: equal-scoring placements must not
		// reorder between runs, or a search would report a different match each call.
		sorted.Sort(delegate(Cand a, Cand b)
		{
			int byScore = b.Score.CompareTo(a.Score);
			if (byScore != 0) return byScore;
			if (a.Y != b.Y) return a.Y.CompareTo(b.Y);
			return a.X.CompareTo(b.X);
		});
		List<Cand> kept = new List<Cand>();
		foreach (Cand c in sorted)
		{
			bool clash = false;
			foreach (Cand k in kept)
			{
				if (Math.Abs(k.X - c.X) <= radius && Math.Abs(k.Y - c.Y) <= radius) { clash = true; break; }
			}
			if (!clash) kept.Add(c);
			if (kept.Count >= keep) break;
		}
		return kept;
	}

	/// <summary>Find a template image on screen with a coarse-to-fine grayscale search.
	/// Returns best matches with their screen coordinates and confidence.</summary>
	public static Dictionary<string, object> FindImage(
		string templatePath, int x, int y, int w, int h,
		double threshold, int tolerance, int maxResults, int step)
	{
		if (!File.Exists(templatePath)) throw new FileNotFoundException("template image not found: " + templatePath);
		Bitmap hay = BitBltRegion(x, y, w, h);
		Bitmap ndl = null;
		try
		{
			ndl = new Bitmap(templatePath);
			if (ndl.Width > hay.Width || ndl.Height > hay.Height)
				throw new InvalidOperationException("template " + ndl.Width + "x" + ndl.Height + " is larger than the search region " + hay.Width + "x" + hay.Height);

			// Pyramid: coarsest factor where the needle is still at least 8px on its short side.
			List<double> factors = new List<double>();
			double f = 0.125;
			while (f < 1.0)
			{
				if (Math.Min(ndl.Width, ndl.Height) * f >= 8) factors.Add(f);
				f *= 2.0;
			}
			factors.Add(1.0);

			List<Cand> candidates = new List<Cand>();
			// Keep a generous candidate set: a low-contrast template scores 1.0 in many
			// places, and a narrow cap would discard the placement the caller meant.
			int keep = Math.Max(32, maxResults * 8);
			bool first = true;
			foreach (double factor in factors)
			{
				Bitmap hayL = factor == 1.0 ? hay : ScaleBitmap((Bitmap)hay.Clone(), factor);
				Bitmap ndlL = factor == 1.0 ? ndl : ScaleBitmap((Bitmap)ndl.Clone(), factor);
				int hw, hh, nw, nh;
				byte[] hayG = GrayFrom(hayL, out hw, out hh);
				byte[] ndlG = GrayFrom(ndlL, out nw, out nh);
				List<Cand> found = new List<Cand>();
				if (first)
				{
					ScoreLevel(hayG, hw, hh, ndlG, nw, nh, tolerance, threshold, Math.Max(1, step), x, y, factor, found, keep);
					first = false;
				}
				else
				{
					int pad = 3;
					foreach (Cand c in candidates)
					{
						int cx = (int)Math.Round((c.X - x) * factor);
						int cy = (int)Math.Round((c.Y - y) * factor);
						int sx = Math.Max(0, cx - pad), sy = Math.Max(0, cy - pad);
						int ex = Math.Min(hw - nw, cx + pad), ey = Math.Min(hh - nh, cy + pad);
						for (int yy = sy; yy <= ey; yy++)
						{
							for (int xx = sx; xx <= ex; xx++)
							{
								int total = nw * nh, good = 0;
								for (int ty = 0; ty < nh; ty++)
								{
									int ho = (yy + ty) * hw + xx, no = ty * nw;
									for (int tx = 0; tx < nw; tx++)
									{
										int diff = hayG[ho + tx] - ndlG[no + tx];
										if (diff < 0) diff = -diff;
										if (diff <= tolerance) good++;
									}
								}
								double score = (double)good / total;
								if (score >= threshold) found.Add(new Cand(x + (int)Math.Round(xx / factor), y + (int)Math.Round(yy / factor), score));
							}
						}
					}
				}
				if (factor != 1.0) { hayL.Dispose(); ndlL.Dispose(); }
				candidates = Dedupe(found, Math.Max(4, (int)(Math.Min(ndl.Width, ndl.Height) * factor / 2.0)), keep);
				if (candidates.Count == 0) break;
			}

			List<Cand> final = Dedupe(candidates, Math.Max(4, Math.Min(ndl.Width, ndl.Height) / 2), Math.Max(1, maxResults));
			List<object> hits = new List<object>();
			foreach (Cand c in final)
			{
				Dictionary<string, object> d = new Dictionary<string, object>();
				d["x"] = c.X; d["y"] = c.Y;
				d["centerX"] = c.X + ndl.Width / 2;
				d["centerY"] = c.Y + ndl.Height / 2;
				d["score"] = Math.Round(c.Score, 4);
				hits.Add(d);
			}
			Dictionary<string, object> res = new Dictionary<string, object>();
			res["found"] = hits.Count > 0;
			res["matches"] = hits;
			res["templateWidth"] = ndl.Width;
			res["templateHeight"] = ndl.Height;
			res["regionX"] = x; res["regionY"] = y; res["regionWidth"] = w; res["regionHeight"] = h;
			res["threshold"] = threshold;
			return res;
		}
		finally
		{
			hay.Dispose();
			if (ndl != null) ndl.Dispose();
		}
	}
}

// =====================================================================
//  Windows, input injection, clipboard, system, and global-hook recording
// =====================================================================
public static class DshWin
{
	// ---------------------------------------------------------------- P/Invoke
	delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);

	[DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr data);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr h);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int max);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
	[DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
	[DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
	[DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
	[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
	[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
	[DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int index);
	[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
	[DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
	[DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
	[DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
	[DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
	[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
	[DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
	[DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
	[DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
	[DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
	[DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
	[DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
	[DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
	[DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, uint pid);
	[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern bool QueryFullProcessImageNameW(IntPtr proc, int flags, StringBuilder name, ref int size);
	[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
	[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT val, int size);
	[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
	[DllImport("user32.dll")] static extern IntPtr GetShellWindow();
	[DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
	[DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);

	[DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
	[DllImport("user32.dll")] static extern bool CloseClipboard();
	[DllImport("user32.dll")] static extern bool EmptyClipboard();
	[DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint fmt);
	[DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint fmt, IntPtr mem);
	[DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint fmt);
	[DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
	[DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr mem);
	[DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr mem);
	[DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr mem);
	[DllImport("kernel32.dll")] static extern IntPtr GlobalSize(IntPtr mem);

	[DllImport("user32.dll")] static extern bool LockWorkStation();
	[DllImport("powrprof.dll", SetLastError = true)] static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)]
	static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);

	[StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
	[StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
	[StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
	[StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
	[StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
	[StructLayout(LayoutKind.Explicit)] struct INPUTUNION
	{
		[FieldOffset(0)] public MOUSEINPUT mi;
		[FieldOffset(0)] public KEYBDINPUT ki;
		[FieldOffset(0)] public HARDWAREINPUT hi;
	}
	[StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

	const int INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
	const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_SCANCODE = 0x0008;
	const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
	const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
	const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
	const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
	const uint MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;

	const int GWL_EXSTYLE = -20;
	const int GWL_STYLE = -16;
	const int WS_DLGFRAME = 0x00400000;
	const int WS_EX_TOOLWINDOW = 0x00000080;
	const int WS_EX_APPWINDOW = 0x00040000;
	const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
	const int DWMWA_CLOAKED = 14;
	const uint GW_OWNER = 4;
	const uint SW_RESTORE = 9, SW_MINIMIZE = 6, SW_MAXIMIZE = 3, SW_SHOW = 5;
	const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004, SWP_SHOWWINDOW = 0x0040;
	// Sign-extended on x64 exactly like the Win32 (HWND)-1 / (HWND)-2 pseudo-handles.
	static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
	static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
	const uint WM_CLOSE = 0x0010;
	const uint WM_SYSCOMMAND = 0x0112;
	const int SC_MONITORPOWER = 0xF170, SC_SCREENSAVE = 0xF140;
	const uint SMTO_ABORTIFHUNG = 0x0002;
	const uint CF_UNICODETEXT = 13;
	const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
	[DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

	/// <summary>Tag every event this plugin injects so the recorder can ignore its own output.</summary>
	public static readonly IntPtr Magic = new IntPtr(0x44534843);

	// ------------------------------------------------------------- windows
	static string WindowText(IntPtr h)
	{
		int len = GetWindowTextLengthW(h);
		if (len <= 0) return "";
		StringBuilder sb = new StringBuilder(len + 2);
		GetWindowTextW(h, sb, sb.Capacity);
		return sb.ToString();
	}

	static string ClassName(IntPtr h)
	{
		StringBuilder sb = new StringBuilder(256);
		GetClassNameW(h, sb, sb.Capacity);
		return sb.ToString();
	}

	static string ProcessName(uint pid)
	{
		IntPtr proc = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
		if (proc == IntPtr.Zero) return "";
		try
		{
			StringBuilder sb = new StringBuilder(1024);
			int size = sb.Capacity;
			if (QueryFullProcessImageNameW(proc, 0, sb, ref size))
			{
				string full = sb.ToString();
				int slash = full.LastIndexOf('\\');
				return slash >= 0 ? full.Substring(slash + 1) : full;
			}
			return "";
		}
		finally { CloseHandle(proc); }
	}

	static bool IsCloaked(IntPtr h)
	{
		try
		{
			int cloaked;
			if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0) return cloaked != 0;
		}
		catch { }
		return false;
	}

	/// <summary>Real visible frame; DWM's extended bounds exclude the invisible resize border.</summary>
	static RECT FrameOf(IntPtr h)
	{
		RECT r;
		try
		{
			if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0)
				return r;
		}
		catch { }
		GetWindowRect(h, out r);
		return r;
	}

	static IntPtr Normalize(IntPtr h)
	{
		IntPtr root = GetAncestor(h, 2); // GA_ROOT
		return root == IntPtr.Zero ? h : root;
	}

	public static List<object> Windows(bool visibleOnly, string titlePattern, string classPattern, string processPattern)
	{
		List<object> list = new List<object>();
		IntPtr fg = GetForegroundWindow();
		IntPtr shell = GetShellWindow();
		int z = 0;
		EnumWindowsProc cb = delegate(IntPtr hwnd, IntPtr data)
		{
			IntPtr h = Normalize(hwnd);
			if (h != hwnd) return true;
			if (h == shell) return true;
			bool visible = IsWindowVisible(h);
			if (visibleOnly && !visible) return true;
			string title = WindowText(h);
			string cls = ClassName(h);
			int ex = GetWindowLongW(h, GWL_EXSTYLE);
			int style = GetWindowLongW(h, GWL_STYLE);
			bool tool = (ex & WS_EX_TOOLWINDOW) != 0 && (ex & WS_EX_APPWINDOW) == 0;
			bool owned = GetWindow(h, GW_OWNER) != IntPtr.Zero;
			if (tool) return true;
			// An owned window is normally an invisible helper, but it is also exactly
			// what a modal dialog is - and a dialog is the one thing an automation must
			// not be blind to (a save confirmation, a file picker). Keep the ones that
			// look like a dialog and drop the rest.
			bool dialog = owned && (cls == "#32770" || (style & WS_DLGFRAME) != 0);
			if (owned && !dialog) return true;
			if (title.Length == 0 && cls != "Progman" && cls != "WorkerW") return true;
			if (dialog && !visible) return true;
			if (IsCloaked(h)) return true;
			uint pid;
			GetWindowThreadProcessId(h, out pid);
			string proc = ProcessName(pid);
			if (titlePattern != null && titlePattern.Length > 0)
			{
				try { if (!System.Text.RegularExpressions.Regex.IsMatch(title, titlePattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return true; }
				catch { }
			}
			if (classPattern != null && classPattern.Length > 0)
			{
				try { if (!System.Text.RegularExpressions.Regex.IsMatch(cls, classPattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return true; }
				catch { }
			}
			if (processPattern != null && processPattern.Length > 0)
			{
				try { if (!System.Text.RegularExpressions.Regex.IsMatch(proc, processPattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return true; }
				catch { }
			}
			RECT r = FrameOf(h);
			Dictionary<string, object> d = new Dictionary<string, object>();
			d["hwnd"] = "0x" + h.ToInt64().ToString("X");
			d["title"] = title;
			d["class"] = cls;
			d["process"] = proc;
			d["pid"] = (int)pid;
			d["x"] = r.Left; d["y"] = r.Top;
			d["width"] = r.Right - r.Left; d["height"] = r.Bottom - r.Top;
			d["visible"] = visible;
			d["minimized"] = IsIconic(h);
			d["maximized"] = IsZoomed(h);
			d["foreground"] = h == fg;
			d["topmost"] = (ex & 0x00000008) != 0;
			if (dialog) d["dialog"] = true;
			d["z"] = z;
			list.Add(d);
			z++;
			return true;
		};
		EnumWindows(cb, IntPtr.Zero);
		return list;
	}

	public static Dictionary<string, object> Foreground()
	{
		IntPtr h = GetForegroundWindow();
		Dictionary<string, object> d = new Dictionary<string, object>();
		if (h == IntPtr.Zero) { d["hwnd"] = null; return d; }
		RECT r = FrameOf(h);
		uint pid;
		GetWindowThreadProcessId(h, out pid);
		d["hwnd"] = "0x" + h.ToInt64().ToString("X");
		d["title"] = WindowText(h);
		d["class"] = ClassName(h);
		d["process"] = ProcessName(pid);
		d["pid"] = (int)pid;
		d["x"] = r.Left; d["y"] = r.Top; d["width"] = r.Right - r.Left; d["height"] = r.Bottom - r.Top;
		return d;
	}

	/// <summary>Resolve a window selector: a hex/dec hwnd, or a case-insensitive
	/// substring/regex over the title. Returns IntPtr.Zero when nothing matches.</summary>
	public static IntPtr Resolve(string selector)
	{
		if (selector == null || selector.Trim().Length == 0) return GetForegroundWindow();
		string s = selector.Trim();
		if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
		{
			long v;
			if (long.TryParse(s.Substring(2), System.Globalization.NumberStyles.HexNumber, null, out v))
			{
				IntPtr h = new IntPtr(v);
				if (IsWindow(h)) return h;
			}
			return IntPtr.Zero;
		}
		bool numeric = true;
		foreach (char c in s) if (c < '0' || c > '9') { numeric = false; break; }
		if (numeric)
		{
			IntPtr h = new IntPtr(long.Parse(s));
			if (IsWindow(h)) return h;
		}
		IntPtr found = IntPtr.Zero;
		EnumWindowsProc cb = delegate(IntPtr hwnd, IntPtr data)
		{
			IntPtr h = Normalize(hwnd);
			if (h != hwnd) return true;
			string title = WindowText(h);
			if (title.Length == 0) return true;
			bool hit = false;
			try { hit = System.Text.RegularExpressions.Regex.IsMatch(title, s, System.Text.RegularExpressions.RegexOptions.IgnoreCase); }
			catch { hit = title.IndexOf(s, StringComparison.OrdinalIgnoreCase) >= 0; }
			if (!hit) return true;
			found = h;
			return false;
		};
		EnumWindows(cb, IntPtr.Zero);
		return found;
	}

	/// <summary>Best-effort foreground activation. Windows only honours
	/// SetForegroundWindow from an eligible process, so this walks a ladder of
	/// the known workarounds and reports which one actually took effect.</summary>
	public static Dictionary<string, object> Activate(IntPtr hwnd)
	{
		string method = "none";
		if (IsIconic(hwnd)) { ShowWindow(hwnd, (int)SW_RESTORE); method = "restore"; }
		if (GetForegroundWindow() != hwnd)
		{
			uint ignored;
			uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
			uint me = GetCurrentThreadId();
			bool attached = false;
			try
			{
				if (fgThread != me && fgThread != 0) attached = AttachThreadInput(me, fgThread, true);
				BringWindowToTop(hwnd);
				SetForegroundWindow(hwnd);
				method = attached ? "attachthreadinput" : "setforegroundwindow";
			}
			finally { if (attached) AttachThreadInput(me, fgThread, false); }
			if (GetForegroundWindow() != hwnd)
			{
				SwitchToThisWindow(hwnd, true);
				method = "switchtothiswindow";
			}
			if (GetForegroundWindow() != hwnd)
			{
				// An ALT tap makes this process eligible to steal the foreground.
				keybd_event(0x12, 0, 0, IntPtr.Zero);
				keybd_event(0x12, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
				SetForegroundWindow(hwnd);
				method = "alt-tap+setforegroundwindow";
			}
		}
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["hwnd"] = "0x" + hwnd.ToInt64().ToString("X");
		d["title"] = WindowText(hwnd);
		d["method"] = method;
		d["focused"] = GetForegroundWindow() == hwnd;
		d["foregroundHwnd"] = "0x" + GetForegroundWindow().ToInt64().ToString("X");
		return d;
	}

	public static Dictionary<string, object> WindowOp(string op, string selector, int a1, int a2, int a3, int a4)
	{
		IntPtr hwnd = Resolve(selector);
		Dictionary<string, object> d = new Dictionary<string, object>();
		if (hwnd == IntPtr.Zero) throw new InvalidOperationException("no window matched selector: " + (selector == null ? "(foreground)" : selector));
		switch (op)
		{
			case "focus": return Activate(hwnd);
			case "minimize": ShowWindow(hwnd, (int)SW_MINIMIZE); break;
			case "maximize": ShowWindow(hwnd, (int)SW_MAXIMIZE); break;
			case "restore": ShowWindow(hwnd, (int)SW_RESTORE); break;
			case "show":
				// SW_SHOW leaves a minimized window minimized: it makes the window
				// visible in its current state. "Show it" has to mean "bring it back".
				ShowWindow(hwnd, (int)(IsIconic(hwnd) ? SW_RESTORE : SW_SHOW));
				break;
			case "close": PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); break;
			case "move": {
				// MoveWindow positions the window rect, but every rectangle this plugin
				// reports is FrameOf - the DWM extended frame, which is the part a person
				// can actually see. On Windows 11 those differ by the invisible resize
				// border (about 7px a side), so passing the request straight through made
				// "put it here" land elsewhere and a read-back disagree with the request.
				// Convert, so the visible window goes exactly where it was asked to go.
				RECT win = new RECT();
				GetWindowRect(hwnd, out win);
				RECT frame = FrameOf(hwnd);
				int insetLeft = frame.Left - win.Left;
				int insetTop = frame.Top - win.Top;
				int insetRight = win.Right - frame.Right;
				int insetBottom = win.Bottom - frame.Bottom;
				MoveWindow(hwnd, a1 - insetLeft, a2 - insetTop, a3 + insetLeft + insetRight, a4 + insetTop + insetBottom, true);
				break;
			}
			case "topmost": SetWindowPos(hwnd, a1 != 0 ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW); break;
			default: throw new ArgumentException("unknown window op: " + op);
		}
		RECT r = FrameOf(hwnd);
		d["hwnd"] = "0x" + hwnd.ToInt64().ToString("X");
		d["title"] = WindowText(hwnd);
		d["op"] = op;
		d["minimized"] = IsIconic(hwnd);
		d["maximized"] = IsZoomed(hwnd);
		d["x"] = r.Left; d["y"] = r.Top; d["width"] = r.Right - r.Left; d["height"] = r.Bottom - r.Top;
		return d;
	}

	// ------------------------------------------------------------- mouse
	static void SendInputs(INPUT[] inputs)
	{
		if (inputs.Length == 0) return;
		uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
		if (sent != inputs.Length) throw new InvalidOperationException("SendInput injected " + sent + " of " + inputs.Length + " events (win32 error " + Marshal.GetLastWin32Error() + ")");
	}

	static INPUT MouseInput(uint flags, int dx, int dy, uint data)
	{
		INPUT i = new INPUT();
		i.type = INPUT_MOUSE;
		i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data;
		i.u.mi.dwFlags = flags; i.u.mi.time = 0; i.u.mi.dwExtraInfo = Magic;
		return i;
	}

	static void AbsoluteMove(int x, int y)
	{
		int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
		int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
		if (vw < 2 || vh < 2) throw new InvalidOperationException("virtual desktop has no usable size");
		int nx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
		int ny = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
		if (nx < 0) nx = 0; if (nx > 65535) nx = 65535;
		if (ny < 0) ny = 0; if (ny > 65535) ny = 65535;
		SendInputs(new INPUT[] { MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0) });
	}

	public static Dictionary<string, object> MouseMove(int x, int y, int durationMs)
	{
		POINT start;
		GetCursorPos(out start);
		if (durationMs <= 0)
		{
			AbsoluteMove(x, y);
		}
		else
		{
			int steps = Math.Max(2, Math.Min(60, durationMs / 10));
			for (int s = 1; s <= steps; s++)
			{
				double t = (double)s / steps;
				AbsoluteMove((int)Math.Round(start.X + (x - start.X) * t), (int)Math.Round(start.Y + (y - start.Y) * t));
				Thread.Sleep(Math.Max(1, durationMs / steps));
			}
		}
		POINT now;
		GetCursorPos(out now);
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["x"] = now.X; d["y"] = now.Y;
		d["requestedX"] = x; d["requestedY"] = y;
		d["landed"] = Math.Abs(now.X - x) <= 1 && Math.Abs(now.Y - y) <= 1;
		return d;
	}

	static uint ButtonDownFlag(string button)
	{
		switch ((button ?? "left").ToLowerInvariant())
		{
			case "left": return MOUSEEVENTF_LEFTDOWN;
			case "right": return MOUSEEVENTF_RIGHTDOWN;
			case "middle": return MOUSEEVENTF_MIDDLEDOWN;
			default: throw new ArgumentException("unknown mouse button: " + button);
		}
	}

	static uint ButtonUpFlag(string button)
	{
		switch ((button ?? "left").ToLowerInvariant())
		{
			case "left": return MOUSEEVENTF_LEFTUP;
			case "right": return MOUSEEVENTF_RIGHTUP;
			case "middle": return MOUSEEVENTF_MIDDLEUP;
			default: throw new ArgumentException("unknown mouse button: " + button);
		}
	}

	public static Dictionary<string, object> MouseButton(string action, string button)
	{
		if (action == "down") SendInputs(new INPUT[] { MouseInput(ButtonDownFlag(button), 0, 0, 0) });
		else if (action == "up") SendInputs(new INPUT[] { MouseInput(ButtonUpFlag(button), 0, 0, 0) });
		else throw new ArgumentException("unknown button action: " + action);
		POINT p;
		GetCursorPos(out p);
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["action"] = action; d["button"] = button ?? "left";
		d["x"] = p.X; d["y"] = p.Y;
		return d;
	}

	public static Dictionary<string, object> MouseClick(string button, int count, int x, int y, bool hasPosition)
	{
		if (hasPosition) AbsoluteMove(x, y);
		POINT p;
		GetCursorPos(out p);
		uint down = ButtonDownFlag(button), up = ButtonUpFlag(button);
		for (int i = 0; i < Math.Max(1, count); i++)
		{
			SendInputs(new INPUT[] { MouseInput(down, 0, 0, 0), MouseInput(up, 0, 0, 0) });
			if (count > 1) Thread.Sleep(40);
		}
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["button"] = button ?? "left";
		d["count"] = Math.Max(1, count);
		d["x"] = p.X; d["y"] = p.Y;
		return d;
	}

	public static Dictionary<string, object> MouseDrag(int x1, int y1, int x2, int y2, string button, int durationMs)
	{
		AbsoluteMove(x1, y1);
		Thread.Sleep(30);
		SendInputs(new INPUT[] { MouseInput(ButtonDownFlag(button), 0, 0, 0) });
		Thread.Sleep(30);
		int steps = Math.Max(4, Math.Min(80, Math.Max(1, durationMs) / 10));
		for (int s = 1; s <= steps; s++)
		{
			double t = (double)s / steps;
			AbsoluteMove((int)Math.Round(x1 + (x2 - x1) * t), (int)Math.Round(y1 + (y2 - y1) * t));
			Thread.Sleep(Math.Max(1, durationMs / steps));
		}
		SendInputs(new INPUT[] { MouseInput(ButtonUpFlag(button), 0, 0, 0) });
		POINT p;
		GetCursorPos(out p);
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["fromX"] = x1; d["fromY"] = y1; d["toX"] = x2; d["toY"] = y2;
		d["button"] = button ?? "left";
		d["x"] = p.X; d["y"] = p.Y;
		return d;
	}

	/// <summary>
	/// Turn the wheel, one notch per event, spaced far enough apart to be counted separately.
	///
	/// The delta used to go out as a single event of whatever size was asked for, and that
	/// does not work: measured on a list, one event carrying -2400 moved two rows, and one
	/// carrying -800 also moved two rows. The size stopped mattering, which is the signature
	/// of a clamp - applications cap the delta they will honour from one wheel event.
	///
	/// Splitting is necessary but not sufficient. Events that arrive within the same frame are
	/// coalesced by the application into one, which would put the whole delta back into a
	/// single clamped event. The pause between them is what makes them separate scrolls, and
	/// it is why this walks the notches instead of handing over an array.
	/// </summary>
	public static Dictionary<string, object> MouseScroll(int delta, bool horizontal)
	{
		const int NOTCH = 120;
		// A cap on how long one call may spend: 400 notches at 6 ms is about two and a half
		// seconds, which is already more scrolling than any caller should need at once.
		const int MAX_NOTCHES = 400;
		const int SPACING_MS = 6;

		uint flag = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
		int remaining = delta;
		int sent = 0;
		while (remaining != 0 && sent < MAX_NOTCHES)
		{
			int step = Math.Abs(remaining) >= NOTCH ? (remaining > 0 ? NOTCH : -NOTCH) : remaining;
			SendInputs(new INPUT[] { MouseInput(flag, 0, 0, unchecked((uint)step)) });
			remaining -= step;
			sent++;
			if (remaining != 0) System.Threading.Thread.Sleep(SPACING_MS);
		}

		POINT p;
		GetCursorPos(out p);
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["delta"] = delta; d["horizontal"] = horizontal;
		d["notches"] = sent;
		// True when the cap cut the request short, so the caller knows why it moved less.
		d["clamped"] = remaining != 0;
		d["x"] = p.X; d["y"] = p.Y;
		return d;
	}

	// How many text lines one wheel notch actually moves, measured on the applications being
	// scrolled rather than read from the system setting.
	//
	// The setting was the obvious source and it is the wrong one. Measured here: a request for
	// twenty lines, converted at the configured three lines per notch, advanced a list by five
	// rows. Applications scroll about one line per notch whatever the setting says, because
	// they handle the wheel themselves instead of deferring to it.
	//
	// So this is a measurement, and if `lines` ever stops matching what the page does, it is
	// the one number to re-measure.
	const int EFFECTIVE_LINES_PER_NOTCH = 1;

	// The two system constants are a pair and it matters which is which:
	//
	//     SPI_GETWHEELSCROLLLINES = 0x0068   reads the setting
	//     SPI_SETWHEELSCROLLLINES = 0x0069   writes it, taking the new value as uiParam
	//
	// This was 0x0069 at first, which is the writing one. Calling it with uiParam 0 to "read"
	// the setting therefore SET it to zero - "one screen at a time" - and applications that
	// treat zero lines as no scrolling stopped scrolling at all. A wrong constant here does
	// not fail, does not throw, and does not return an error: it silently changes a setting
	// belonging to the person using the machine, and the symptom appears in their mouse
	// rather than in this program. The read is spelled out with its own name for that reason.
	const uint SPI_GETWHEELSCROLLLINES = 0x0068;

	[DllImport("user32.dll", SetLastError = true)]
	static extern bool SystemParametersInfo(uint action, uint param, out uint value, uint flags);

	public static Dictionary<string, object> MouseScrollLines(int lines, bool horizontal)
	{
		// A read, and only a read: the action above is the GET, the value comes back through
		// the out parameter, and nothing here writes to the system.
		uint configured = 0;
		bool read = SystemParametersInfo(SPI_GETWHEELSCROLLLINES, 0, out configured, 0);

		int delta = (int)Math.Round((double)lines / EFFECTIVE_LINES_PER_NOTCH * 120.0);
		// A request for movement must not round away to nothing.
		if (delta == 0 && lines != 0) delta = lines > 0 ? 120 : -120;

		Dictionary<string, object> applied = MouseScroll(delta, horizontal);
		applied["lines"] = lines;
		applied["linesPerNotch"] = EFFECTIVE_LINES_PER_NOTCH;
		// What the machine says, which is not what was used, reported so the difference is
		// visible rather than surprising.
		applied["systemLinesPerNotch"] = read ? (int)configured : -1;
		return applied;
	}

	// ------------------------------------------------------------- keyboard
	static readonly Dictionary<string, int> Vk = BuildVk();

	static Dictionary<string, int> BuildVk()
	{
		Dictionary<string, int> m = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
		for (char c = 'A'; c <= 'Z'; c++) m[c.ToString()] = c;
		for (char c = '0'; c <= '9'; c++) m[c.ToString()] = c;
		for (int i = 1; i <= 24; i++) m["f" + i] = 0x6F + i;
		m["backspace"] = 0x08; m["back"] = 0x08; m["tab"] = 0x09;
		m["clear"] = 0x0C; m["enter"] = 0x0D; m["return"] = 0x0D;
		m["shift"] = 0x10; m["ctrl"] = 0x11; m["control"] = 0x11; m["alt"] = 0x12;
		m["pause"] = 0x13; m["capslock"] = 0x14; m["caps"] = 0x14;
		m["esc"] = 0x1B; m["escape"] = 0x1B; m["space"] = 0x20;
		m["pageup"] = 0x21; m["pagedown"] = 0x22; m["end"] = 0x23; m["home"] = 0x24;
		m["left"] = 0x25; m["up"] = 0x26; m["right"] = 0x27; m["down"] = 0x28;
		m["select"] = 0x29; m["print"] = 0x2A; m["printscreen"] = 0x2C; m["insert"] = 0x2D; m["delete"] = 0x2E; m["del"] = 0x2E;
		m["help"] = 0x2F;
		m["lwin"] = 0x5B; m["win"] = 0x5B; m["meta"] = 0x5B; m["rwin"] = 0x5C;
		m["apps"] = 0x5D; m["menu"] = 0x5D;
		m["numpad0"] = 0x60; m["numpad1"] = 0x61; m["numpad2"] = 0x62; m["numpad3"] = 0x63; m["numpad4"] = 0x64;
		m["numpad5"] = 0x65; m["numpad6"] = 0x66; m["numpad7"] = 0x67; m["numpad8"] = 0x68; m["numpad9"] = 0x69;
		m["multiply"] = 0x6A; m["add"] = 0x6B; m["separator"] = 0x6C; m["subtract"] = 0x6D; m["decimal"] = 0x6E; m["divide"] = 0x6F;
		m["numlock"] = 0x90; m["scrolllock"] = 0x91; m["scroll"] = 0x91;
		m["lshift"] = 0xA0; m["rshift"] = 0xA1; m["lctrl"] = 0xA2; m["rctrl"] = 0xA3; m["lalt"] = 0xA4; m["ralt"] = 0xA5;
		m["volumeup"] = 0xAF; m["volumedown"] = 0xAE; m["volumemute"] = 0xAD; m["mute"] = 0xAD;
		m["nexttrack"] = 0xB0; m["prevtrack"] = 0xB1; m["stopmedia"] = 0xB2; m["playpause"] = 0xB3; m["mediaplaypause"] = 0xB3;
		m["browserback"] = 0xA6; m["browserforward"] = 0xA7; m["browserrefresh"] = 0xA8; m["browserstop"] = 0xA9;
		m["semicolon"] = 0xBA; m[";"] = 0xBA; m["plus"] = 0xBB; m["="] = 0xBB; m["comma"] = 0xBC; m[","] = 0xBC;
		m["minus"] = 0xBD; m["-"] = 0xBD; m["period"] = 0xBE; m["."] = 0xBE; m["slash"] = 0xBF; m["/"] = 0xBF;
		m["backtick"] = 0xC0; m["`"] = 0xC0; m["tilde"] = 0xC0;
		m["lbracket"] = 0xDB; m["["] = 0xDB; m["backslash"] = 0xDC; m["\\"] = 0xDC;
		m["rbracket"] = 0xDD; m["]"] = 0xDD; m["quote"] = 0xDE; m["'"] = 0xDE;
		return m;
	}

	static ushort ResolveKey(string key)
	{
		if (key == null) throw new ArgumentException("key name is required");
		string s = key.Trim();
		if (s.Length == 0) throw new ArgumentException("key name is required");
		int vk;
		if (Vk.TryGetValue(s, out vk)) return (ushort)vk;
		throw new ArgumentException("unknown key name: " + key);
	}

	static bool IsExtended(ushort vk)
	{
		switch (vk)
		{
			case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27: case 0x28:
			case 0x2C: case 0x2D: case 0x2E: case 0x5B: case 0x5C: case 0x5D: case 0x6F:
			case 0xA3: case 0xA5: case 0x90:
				return true;
			default:
				return false;
		}
	}

	static INPUT KeyInput(ushort vk, ushort scan, bool up, bool unicode)
	{
		INPUT i = new INPUT();
		i.type = INPUT_KEYBOARD;
		i.u.ki.wVk = unicode ? (ushort)0 : vk;
		i.u.ki.wScan = scan;
		uint flags = 0;
		if (up) flags |= KEYEVENTF_KEYUP;
		if (unicode) flags |= KEYEVENTF_UNICODE;
		else if (IsExtended(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
		i.u.ki.dwFlags = flags;
		i.u.ki.time = 0;
		i.u.ki.dwExtraInfo = Magic;
		return i;
	}

	/// <summary>Type literal text through KEYEVENTF_UNICODE, so CJK, emoji and any
	/// layout-independent character arrive exactly as written.</summary>
	public static Dictionary<string, object> KeyType(string text, int delayMs)
	{
		if (text == null) text = "";
		int sent = 0;
		foreach (char ch in text)
		{
			if (ch == '\r') continue;
			if (ch == '\n') { KeyPress("enter", "press", 1); sent++; if (delayMs > 0) Thread.Sleep(delayMs); continue; }
			if (ch == '\t') { KeyPress("tab", "press", 1); sent++; if (delayMs > 0) Thread.Sleep(delayMs); continue; }
			SendInputs(new INPUT[] { KeyInput(0, ch, false, true), KeyInput(0, ch, true, true) });
			sent++;
			if (delayMs > 0) Thread.Sleep(delayMs);
		}
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["characters"] = sent;
		d["length"] = text.Length;
		return d;
	}

	public static Dictionary<string, object> KeyPress(string key, string action, int repeat)
	{
		ushort vk = ResolveKey(key);
		int n = Math.Max(1, repeat);
		for (int i = 0; i < n; i++)
		{
			if (action == "down") SendInputs(new INPUT[] { KeyInput(vk, 0, false, false) });
			else if (action == "up") SendInputs(new INPUT[] { KeyInput(vk, 0, true, false) });
			else if (action == "press") SendInputs(new INPUT[] { KeyInput(vk, 0, false, false), KeyInput(vk, 0, true, false) });
			else throw new ArgumentException("unknown key action: " + action);
			if (n > 1) Thread.Sleep(30);
		}
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["key"] = key; d["action"] = action; d["repeat"] = n; d["vk"] = (int)vk;
		return d;
	}

	/// <summary>Press a raw virtual-key code, used when replaying recorded input.</summary>
	public static Dictionary<string, object> KeyVk(int vk, string action)
	{
		if (vk <= 0 || vk > 255) throw new ArgumentException("vk must be between 1 and 255, got " + vk);
		ushort code = (ushort)vk;
		if (action == "down") SendInputs(new INPUT[] { KeyInput(code, 0, false, false) });
		else if (action == "up") SendInputs(new INPUT[] { KeyInput(code, 0, true, false) });
		else if (action == "press") SendInputs(new INPUT[] { KeyInput(code, 0, false, false), KeyInput(code, 0, true, false) });
		else throw new ArgumentException("unknown key action: " + action);
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["vk"] = vk;
		d["action"] = action;
		return d;
	}

	/// <summary>Press a chord such as "ctrl+shift+esc": every part but the last is
	/// held down, the last is tapped, then the modifiers release in reverse order.</summary>
	public static Dictionary<string, object> KeyHotkey(string chord)
	{
		if (chord == null || chord.Trim().Length == 0) throw new ArgumentException("hotkey is required");
		string[] parts = chord.Split('+');
		List<ushort> vks = new List<ushort>();
		foreach (string raw in parts)
		{
			string p = raw.Trim();
			if (p.Length == 0) continue;
			vks.Add(ResolveKey(p));
		}
		if (vks.Count == 0) throw new ArgumentException("hotkey is required");
		List<INPUT> seq = new List<INPUT>();
		for (int i = 0; i < vks.Count - 1; i++) seq.Add(KeyInput(vks[i], 0, false, false));
		int last = vks.Count - 1;
		seq.Add(KeyInput(vks[last], 0, false, false));
		seq.Add(KeyInput(vks[last], 0, true, false));
		for (int i = vks.Count - 2; i >= 0; i--) seq.Add(KeyInput(vks[i], 0, true, false));
		SendInputs(seq.ToArray());
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["hotkey"] = chord;
		d["keys"] = vks.Count;
		return d;
	}

	// ------------------------------------------------------------- clipboard
	static bool OpenClipboardRetry()
	{
		for (int i = 0; i < 12; i++)
		{
			if (OpenClipboard(IntPtr.Zero)) return true;
			Thread.Sleep(60);
		}
		return false;
	}

	public static string ClipGet()
	{
		if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return "";
		if (!OpenClipboardRetry()) throw new InvalidOperationException("could not open the clipboard (another process is holding it)");
		try
		{
			IntPtr h = GetClipboardData(CF_UNICODETEXT);
			if (h == IntPtr.Zero) return "";
			IntPtr p = GlobalLock(h);
			if (p == IntPtr.Zero) return "";
			try { return Marshal.PtrToStringUni(p); }
			finally { GlobalUnlock(h); }
		}
		finally { CloseClipboard(); }
	}

	public static Dictionary<string, object> ClipSet(string text)
	{
		if (text == null) text = "";
		if (!OpenClipboardRetry()) throw new InvalidOperationException("could not open the clipboard (another process is holding it)");
		try
		{
			if (!EmptyClipboard()) throw new InvalidOperationException("EmptyClipboard failed");
			byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
			IntPtr mem = GlobalAlloc(0x0042, (UIntPtr)bytes.Length); // GMEM_MOVEABLE | GMEM_ZEROINIT
			if (mem == IntPtr.Zero) throw new InvalidOperationException("GlobalAlloc failed");
			IntPtr dst = GlobalLock(mem);
			if (dst == IntPtr.Zero) { GlobalFree(mem); throw new InvalidOperationException("GlobalLock failed"); }
			Marshal.Copy(bytes, 0, dst, bytes.Length);
			GlobalUnlock(mem);
			if (SetClipboardData(CF_UNICODETEXT, mem) == IntPtr.Zero)
			{
				GlobalFree(mem);
				throw new InvalidOperationException("SetClipboardData failed");
			}
			// Ownership of mem transferred to the clipboard; do not free it here.
			Dictionary<string, object> d = new Dictionary<string, object>();
			d["length"] = text.Length;
			return d;
		}
		finally { CloseClipboard(); }
	}

	// ------------------------------------------------------------- system
	public static Dictionary<string, object> SystemOp(string op)
	{
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["op"] = op;
		switch (op)
		{
			case "volume-up": KeyPress("volumeup", "press", 2); break;
			case "volume-down": KeyPress("volumedown", "press", 2); break;
			case "mute": KeyPress("volumemute", "press", 1); break;
			case "show-desktop":
				KeyHotkey("lwin+d");
				break;
			case "lock":
				if (!LockWorkStation()) throw new InvalidOperationException("LockWorkStation failed");
				break;
			case "monitor-off":
				{
					IntPtr res;
					SendMessageTimeoutW(new IntPtr(0xFFFF), WM_SYSCOMMAND, new IntPtr(SC_MONITORPOWER), new IntPtr(2), SMTO_ABORTIFHUNG, 2000, out res);
					break;
				}
			case "screensaver":
				{
					IntPtr res;
					SendMessageTimeoutW(new IntPtr(0xFFFF), WM_SYSCOMMAND, new IntPtr(SC_SCREENSAVE), IntPtr.Zero, SMTO_ABORTIFHUNG, 2000, out res);
					break;
				}
			case "sleep":
				if (!SetSuspendState(false, false, false)) throw new InvalidOperationException("SetSuspendState failed (the caller may lack the privilege)");
				break;
			default: throw new ArgumentException("unknown system op: " + op);
		}
		return d;
	}
}

// =====================================================================
//  Low-level global input recording (WH_MOUSE_LL / WH_KEYBOARD_LL)
// =====================================================================
public static class DshHook
{
	delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

	[DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookExW(int id, HookProc proc, IntPtr mod, uint threadId);
	[DllImport("user32.dll", SetLastError = true)] static extern bool UnhookWindowsHookEx(IntPtr hook);
	[DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
	[DllImport("user32.dll")] static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
	[DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
	[DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG msg);
	[DllImport("user32.dll")] static extern bool PostThreadMessageW(uint threadId, uint msg, IntPtr w, IntPtr l);
	[DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);

	[StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
	[StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr dwExtraInfo; }
	[StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }
	[StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }

	const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
	const uint WM_QUIT = 0x0012;
	const uint LLKHF_INJECTED = 0x10, LLMHF_INJECTED = 0x01;

	static readonly object gate = new object();
	static HookProc mouseProc, keyProc;
	static IntPtr mouseHook = IntPtr.Zero, keyHook = IntPtr.Zero;
	static Thread pump;
	static uint pumpThreadId;
	static volatile bool recording;
	static List<object> events = new List<object>();
	static long startedAt;

	public static bool Recording { get { return recording; } }

	public static Dictionary<string, object> Start()
	{
		lock (gate)
		{
			if (recording) throw new InvalidOperationException("a recording is already running");
			events = new List<object>();
			recording = true;
			startedAt = Environment.TickCount;
		}
		ManualResetEventSlim ready = new ManualResetEventSlim(false);
		string failure = null;
		pump = new Thread(delegate()
		{
			try
			{
				pumpThreadId = GetCurrentThreadId();
				IntPtr mod = GetModuleHandleW(null);
				mouseProc = MouseCallback;
				keyProc = KeyCallback;
				mouseHook = SetWindowsHookExW(WH_MOUSE_LL, mouseProc, mod, 0);
				keyHook = SetWindowsHookExW(WH_KEYBOARD_LL, keyProc, mod, 0);
				if (mouseHook == IntPtr.Zero || keyHook == IntPtr.Zero)
				{
					failure = "SetWindowsHookEx failed (win32 error " + Marshal.GetLastWin32Error() + ")";
					ready.Set();
					return;
				}
				ready.Set();
				MSG msg;
				while (GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0)
				{
					TranslateMessage(ref msg);
					DispatchMessageW(ref msg);
				}
			}
			catch (Exception ex)
			{
				failure = ex.Message;
				ready.Set();
			}
			finally
			{
				if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
				if (keyHook != IntPtr.Zero) { UnhookWindowsHookEx(keyHook); keyHook = IntPtr.Zero; }
			}
		});
		pump.IsBackground = true;
		pump.SetApartmentState(ApartmentState.STA);
		pump.Start();
		ready.Wait(5000);
		if (failure != null)
		{
			recording = false;
			throw new InvalidOperationException("could not install global input hooks: " + failure);
		}
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["recording"] = true;
		return d;
	}

	public static Dictionary<string, object> Stop()
	{
		lock (gate) { recording = false; }
		if (pumpThreadId != 0) PostThreadMessageW(pumpThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
		if (pump != null) pump.Join(3000);
		pumpThreadId = 0;
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["recording"] = false;
		d["count"] = events.Count;
		d["events"] = Snapshot();
		return d;
	}

	public static List<object> Snapshot()
	{
		lock (gate) { return new List<object>(events); }
	}

	static void Push(Dictionary<string, object> e)
	{
		lock (gate)
		{
			if (!recording) return;
			long t = Environment.TickCount - startedAt;
			// A real mouse produces hundreds of micro-moves per second; collapsing
			// them keeps a recording replayable and small without changing its path.
			if (events.Count > 0 && (e["kind"] as string) == "mouse" && Convert.ToInt64(e["msg"]) == 0x200)
			{
				Dictionary<string, object> last = events[events.Count - 1] as Dictionary<string, object>;
				if (last != null && (last["kind"] as string) == "mouse" && Convert.ToInt64(last["msg"]) == 0x200)
				{
					long lt = Convert.ToInt64(last["t"]);
					int lx = Convert.ToInt32(last["x"]), ly = Convert.ToInt32(last["y"]);
					int nx = Convert.ToInt32(e["x"]), ny = Convert.ToInt32(e["y"]);
					if (t - lt < 20 && Math.Abs(nx - lx) < 4 && Math.Abs(ny - ly) < 4) return;
				}
			}
			e["t"] = t;
			if (events.Count < 200000) events.Add(e);
		}
	}

	static IntPtr MouseCallback(int code, IntPtr wParam, IntPtr lParam)
	{
		if (code >= 0)
		{
			MSLLHOOKSTRUCT s = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
			if (s.dwExtraInfo != DshWin.Magic && (s.flags & LLMHF_INJECTED) == 0)
			{
				Dictionary<string, object> e = new Dictionary<string, object>();
				e["kind"] = "mouse";
				e["msg"] = wParam.ToInt64();
				e["x"] = s.pt.X; e["y"] = s.pt.Y;
				e["data"] = unchecked((int)s.mouseData);
				e["flags"] = (int)s.flags;
				Push(e);
			}
		}
		return CallNextHookEx(mouseHook, code, wParam, lParam);
	}

	static IntPtr KeyCallback(int code, IntPtr wParam, IntPtr lParam)
	{
		if (code >= 0)
		{
			KBDLLHOOKSTRUCT s = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
			if (s.dwExtraInfo != DshWin.Magic && (s.flags & LLKHF_INJECTED) == 0)
			{
				Dictionary<string, object> e = new Dictionary<string, object>();
				e["kind"] = "key";
				e["msg"] = wParam.ToInt64();
				e["vk"] = (int)s.vkCode;
				e["scan"] = (int)s.scanCode;
				e["flags"] = (int)s.flags;
				Push(e);
			}
		}
		return CallNextHookEx(keyHook, code, wParam, lParam);
	}
}
