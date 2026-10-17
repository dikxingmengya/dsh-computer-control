// On-screen indicators for computer-control.
//
// Two layered, click-through, never-activating windows:
//   * a capture frame that outlines the rectangle about to be captured
//   * a badge that says which input the plugin is injecting right now
//
// Both are marked with SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) so the
// capture APIs do not see them; a capture must never contain its own indicator.
// When that system capability is unavailable the caller falls back to hiding the
// indicator before the shutter, which is why `ExcludedFromCapture` is reported.
//
// Target: C# 5 / .NET Framework 4.x (no string interpolation, no out-var).
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class DshOverlay
{
	delegate IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

	// ---------------------------------------------------------------- P/Invoke
	[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern ushort RegisterClassExW(ref WNDCLASSEX wc);
	[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName, uint style,
		int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)]
	static extern IntPtr DefWindowProcW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
	[DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
	[DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
	[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
	[DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
	[DllImport("user32.dll", SetLastError = true)] static extern int SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
	[DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr hwnd, IntPtr id, uint ms, IntPtr proc);
	[DllImport("user32.dll")] static extern bool KillTimer(IntPtr hwnd, IntPtr id);
	[DllImport("user32.dll")] static extern bool InvalidateRect(IntPtr hwnd, IntPtr rect, bool erase);
	[DllImport("user32.dll")] static extern bool UpdateWindow(IntPtr hwnd);
	[DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
	[DllImport("user32.dll")] static extern IntPtr BeginPaint(IntPtr hwnd, out PAINTSTRUCT ps);
	[DllImport("user32.dll")] static extern bool EndPaint(IntPtr hwnd, ref PAINTSTRUCT ps);
	[DllImport("user32.dll")] static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
	[DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
	[DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG msg);
	[DllImport("user32.dll")] static extern bool PostThreadMessageW(uint threadId, uint msg, IntPtr wParam, IntPtr lParam);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int DrawTextW(IntPtr hdc, string text, int count, ref RECT rect, uint format);
	[DllImport("user32.dll")] static extern bool SystemParametersInfoW(uint action, uint param, ref RECT rect, uint winIni);
	[DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
	[DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(uint color);
	[DllImport("gdi32.dll")] static extern IntPtr CreatePen(int style, int width, uint color);
	[DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
	[DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
	[DllImport("gdi32.dll")] static extern int SetBkMode(IntPtr hdc, int mode);
	[DllImport("gdi32.dll")] static extern uint SetTextColor(IntPtr hdc, uint color);
	[DllImport("gdi32.dll")] static extern uint SetBkColor(IntPtr hdc, uint color);
	[DllImport("gdi32.dll")] static extern bool GetTextExtentPoint32W(IntPtr hdc, string text, int count, out SIZE size);
	[DllImport("gdi32.dll")] static extern bool RoundRect(IntPtr hdc, int left, int top, int right, int bottom, int width, int height);
	[DllImport("gdi32.dll")] static extern bool Ellipse(IntPtr hdc, int left, int top, int right, int bottom);
	[DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
	static extern IntPtr CreateFontW(int height, int width, int escapement, int orientation, int weight,
		uint italic, uint underline, uint strikeOut, uint charSet, uint outPrecision, uint clipPrecision,
		uint quality, uint pitchAndFamily, string face);
	[DllImport("user32.dll")] static extern int FillRect(IntPtr hdc, ref RECT rect, IntPtr brush);

	[StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
	[StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
	[StructLayout(LayoutKind.Sequential)] struct PAINTSTRUCT
	{
		public IntPtr hdc; public bool fErase; public RECT rcPaint; public bool fRestore; public bool fIncUpdate;
		[MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[] rgbReserved;
	}
	[StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
	[StructLayout(LayoutKind.Sequential)] struct MSG
	{
		public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt;
	}
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	struct WNDCLASSEX
	{
		public uint cbSize; public uint style; public WndProc lpfnWndProc;
		public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance, hIcon, hCursor, hbrBackground;
		[MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName;
		[MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
		public IntPtr hIconSm;
	}

	const uint WM_PAINT = 0x000F, WM_ERASEBKGND = 0x0014, WM_TIMER = 0x0113;
	const uint WM_QUIT = 0x0012;
	const uint WS_POPUP = 0x80000000;
	const uint WS_EX_LAYERED = 0x00080000, WS_EX_TRANSPARENT = 0x00000020;
	const uint WS_EX_TOOLWINDOW = 0x00000080, WS_EX_TOPMOST = 0x00000008, WS_EX_NOACTIVATE = 0x08000000;
	const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;
	const int SW_HIDE = 0;
	const uint LWA_COLORKEY = 0x00000001, LWA_ALPHA = 0x00000002;
	/// <summary>Windows 10 2004+: the window is composited for the user but omitted from captures.</summary>
	const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
	const uint SPI_GETWORKAREA = 0x0030;
	const uint DT_SINGLELINE = 0x00000020, DT_VCENTER = 0x00000004, DT_LEFT = 0x00000000, DT_NOPREFIX = 0x00000800;

	static readonly IntPtr TIMER_FRAME_HOLD = new IntPtr(1);
	static readonly IntPtr TIMER_BADGE_HIDE = new IntPtr(2);
	static readonly IntPtr TIMER_BADGE_PULSE = new IntPtr(3);

	// BGR order, as COLORREF is 0x00BBGGRR.
	static readonly uint KeyColor = 0x00FF00FF;      // magenta matte, never drawn as content
	static readonly uint FrameAccent = 0x00FE6B4D;   // #4D6BFE brand blue: the shutter marker

	// The badge is a black-and-white pair: a white pill on a light theme, a
	// near-black one on a dark theme, each with a neutral hairline and a matching
	// dot. Only the capture frame keeps the brand blue, because it has to stay
	// legible against arbitrary screen content. COLORREF is 0x00BBGGRR.
	static readonly uint DarkLabelBack = 0x001C1612;   // #12161C
	static readonly uint DarkLabelText = 0x00FFFFFF;
	static readonly uint DarkBadgeBack = 0x001D1816;   // #16181D
	static readonly uint DarkBadgeText = 0x00FFFFFF;
	static readonly uint DarkBadgeEdge = 0x004D413B;   // #3B414D
	static readonly uint DarkDotOn = 0x00FFFFFF;
	static readonly uint DarkDotOff = 0x0080726B;      // #6B7280
	static readonly uint LightLabelBack = 0x00FFFFFF;
	static readonly uint LightLabelText = 0x00271F1B;  // #1B1F27
	static readonly uint LightBadgeBack = 0x00FFFFFF;
	static readonly uint LightBadgeText = 0x00271F1B;
	static readonly uint LightBadgeEdge = 0x00E0D9D5;  // #D5D9E0
	static readonly uint LightDotOn = 0x00271F1B;
	static readonly uint LightDotOff = 0x00ADA19A;     // #9AA1AD

	/// <summary>Explicit theme set by the caller, or empty to follow Windows.</summary>
	static string requestedTheme = "";
	static string resolvedTheme = "";

	static uint LabelBack { get { return resolvedTheme == "light" ? LightLabelBack : DarkLabelBack; } }
	static uint LabelText { get { return resolvedTheme == "light" ? LightLabelText : DarkLabelText; } }
	static uint BadgeBack { get { return resolvedTheme == "light" ? LightBadgeBack : DarkBadgeBack; } }
	static uint BadgeText { get { return resolvedTheme == "light" ? LightBadgeText : DarkBadgeText; } }
	static uint BadgeEdge { get { return resolvedTheme == "light" ? LightBadgeEdge : DarkBadgeEdge; } }
	static uint DotOn { get { return resolvedTheme == "light" ? LightDotOn : DarkDotOn; } }
	static uint DotOff { get { return resolvedTheme == "light" ? LightDotOff : DarkDotOff; } }

	/// <summary>
	/// Decide which palette to draw with: an explicit request wins, otherwise the
	/// Windows app theme decides, so a "system" preference still lands correctly.
	/// </summary>
	static string ResolveTheme()
	{
		if (requestedTheme == "light" || requestedTheme == "dark")
		{
			resolvedTheme = requestedTheme;
			return resolvedTheme;
		}
		string previous = resolvedTheme;
		resolvedTheme = "dark";
		try
		{
			object value = Microsoft.Win32.Registry.GetValue(
				@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
				"AppsUseLightTheme", null);
			if (value is int && (int)value == 1) resolvedTheme = "light";
		}
		catch { }
		// Repaint only when the answer actually moved.
		if (previous != resolvedTheme)
		{
			if (frameWnd != IntPtr.Zero) InvalidateRect(frameWnd, IntPtr.Zero, false);
			if (badgeWnd != IntPtr.Zero) InvalidateRect(badgeWnd, IntPtr.Zero, false);
		}
		return resolvedTheme;
	}

	/// <summary>Accept "light"/"dark" from the caller; anything else means "follow Windows".</summary>
	static string NormalizeTheme(string theme)
	{
		if (theme == null) return "";
		string value = theme.Trim().ToLowerInvariant();
		return (value == "light" || value == "dark") ? value : "";
	}

	static readonly object gate = new object();
	static WndProc sharedCallback;
	static IntPtr frameWnd = IntPtr.Zero, badgeWnd = IntPtr.Zero;
	static Thread pump;
	static uint pumpThreadId;
	static volatile bool running;
	static volatile bool captureExcluded;
	static string excludeFailure = "";
	static string className = "DshComputerControlOverlay";

	static volatile bool frameVisible;
	static string frameLabel = "";
	static int frameThickness = 3;

	static volatile bool badgeVisible;
	static string badgeText = "";
	static int badgePhase;

	/// <summary>Machine-wide claim on the indicators: one owner draws, everyone else stays off screen.</summary>
	const string OwnershipName = "Global\\DshComputerControlOverlay";
	static Mutex ownership;
	/// <summary>Why the indicators are not drawn here, when they are not.</summary>
	static string unavailableReason = "";

	static IntPtr font;

	/// <summary>Whether capture APIs are known to omit these windows.</summary>
	public static bool ExcludedFromCapture { get { return captureExcluded; } }

	// ---------------------------------------------------------------- lifecycle
	/// <summary>
	/// Start the indicator. With <paramref name="claim"/> set, this process must be
	/// the only one drawing on screen: two helpers - a second profile, a stale one,
	/// a diagnostic script - would otherwise stack two badges on the same spot.
	/// </summary>
	public static Dictionary<string, object> Start(bool claim)
	{
		if (running) return Status();
		if (claim)
		{
			bool created;
			try
			{
				ownership = new Mutex(false, OwnershipName, out created);
			}
			catch (Exception ex)
			{
				created = true;
				excludeFailure = "the indicator ownership check failed: " + ex.Message;
			}
			if (!created)
			{
				if (ownership != null) { ownership.Dispose(); ownership = null; }
				unavailableReason = "another process already owns the on-screen indicators";
				Dictionary<string, object> refused = new Dictionary<string, object>();
				refused["available"] = false;
				refused["captureExcluded"] = false;
				refused["reason"] = unavailableReason;
				return refused;
			}
		}
		font = CreateFontW(-15, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Microsoft YaHei UI");
		if (font == IntPtr.Zero) font = CreateFontW(-15, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe UI");
		ManualResetEventSlim ready = new ManualResetEventSlim(false);
		string failure = null;
		pump = new Thread(delegate()
		{
			try
			{
				pumpThreadId = GetCurrentThreadId();
				IntPtr instance = GetModuleHandleW(null);
				sharedCallback = SharedProc;
				WNDCLASSEX wc = new WNDCLASSEX();
				wc.cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX));
				wc.style = 0;
				wc.lpfnWndProc = sharedCallback;
				wc.hInstance = instance;
				wc.hbrBackground = IntPtr.Zero;
				wc.lpszClassName = className;
				if (RegisterClassExW(ref wc) == 0)
				{
					// 1410 = the class is already registered, which is fine: the process
					// keeps one class for the whole run and its procedure never changes.
					int error = Marshal.GetLastWin32Error();
					if (error != 1410)
					{
						failure = "RegisterClassEx failed (win32 error " + error + ")";
						ready.Set();
						return;
					}
				}
				uint ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE;
				frameWnd = CreateWindowExW(ex, className, "dsh-capture-frame", WS_POPUP, 0, 0, 10, 10, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
				if (frameWnd == IntPtr.Zero)
				{
					failure = "CreateWindowEx(frame) failed (win32 error " + Marshal.GetLastWin32Error() + ")";
					ready.Set();
					return;
				}
				badgeWnd = CreateWindowExW(ex, className, "dsh-input-badge", WS_POPUP, 0, 0, 10, 10, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
				if (badgeWnd == IntPtr.Zero)
				{
					failure = "CreateWindowEx(badge) failed (win32 error " + Marshal.GetLastWin32Error() + ")";
					ready.Set();
					return;
				}
				SetLayeredWindowAttributes(frameWnd, KeyColor, 235, LWA_COLORKEY | LWA_ALPHA);
				SetLayeredWindowAttributes(badgeWnd, KeyColor, 240, LWA_COLORKEY | LWA_ALPHA);
				// Capture exclusion is NOT applied here. It is opt-in through
				// SetCaptureExclusion, because on some display pipelines
				// (WDA_EXCLUDEFROMCAPTURE still reports success while the window
				// disappears from the DWM composition the monitor shows, which would
				// hide the indicator from the very person it exists to warn). The
				// default keeps the indicator plainly on screen and takes it down
				// before each shutter instead.
				captureExcluded = false;
				excludeFailure = "";
				running = true;
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
				running = false;
				if (frameWnd != IntPtr.Zero) { DestroyWindow(frameWnd); frameWnd = IntPtr.Zero; }
				if (badgeWnd != IntPtr.Zero) { DestroyWindow(badgeWnd); badgeWnd = IntPtr.Zero; }
				if (font != IntPtr.Zero) { DeleteObject(font); font = IntPtr.Zero; }
				if (ownership != null) { try { ownership.ReleaseMutex(); } catch { } ownership.Dispose(); ownership = null; }
			}
		});
		pump.IsBackground = true;
		pump.SetApartmentState(ApartmentState.STA);
		pump.Start();
		ready.Wait(5000);
		if (failure != null) throw new InvalidOperationException("the on-screen indicator could not start: " + failure);
		if (!running) throw new InvalidOperationException("the on-screen indicator thread exited during startup");
		return Status();
	}

	public static Dictionary<string, object> Stop()
	{
		if (running && pumpThreadId != 0) PostThreadMessageW(pumpThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
		if (pump != null) pump.Join(3000);
		pumpThreadId = 0;
		return Status();
	}

	public static Dictionary<string, object> Status()
	{
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["available"] = running;
		d["ownsScreen"] = ownership != null;
		d["captureExcluded"] = captureExcluded;
		d["excludeFailure"] = excludeFailure;
		d["frameVisible"] = frameVisible;
		d["badgeVisible"] = badgeVisible;
		d["frameLabel"] = frameLabel;
		d["badgeText"] = badgeText;
		d["theme"] = ResolveTheme();
		d["requestedTheme"] = requestedTheme;
		return d;
	}

	/// <summary>Ensure the indicator thread exists; safe to call before every use.</summary>
	public static void Ensure()
	{
		if (!running) Start(true);
	}

	/// <summary>
	/// Nothing is drawn here, so nothing may claim to have been drawn: a refused
	/// claim must surface as an unshown result, never as a silent success.
	/// </summary>
	static Dictionary<string, object> NotShown()
	{
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["shown"] = false;
		d["reason"] = unavailableReason.Length > 0
			? unavailableReason
			: (running ? "the indicator window is not ready" : "the on-screen indicator is not running");
		return d;
	}

	/// <summary>
	/// Turn capture exclusion on or off. Off is a diagnostic: it puts the
	/// indicator back into captures so its placement can be inspected.
	/// </summary>
	public static Dictionary<string, object> SetCaptureExclusion(bool exclude)
	{
		Ensure();		uint affinity = exclude ? WDA_EXCLUDEFROMCAPTURE : 0; // WDA_NONE
		int a = SetWindowDisplayAffinity(frameWnd, affinity);
		int b = SetWindowDisplayAffinity(badgeWnd, affinity);
		bool ok = a != 0 && b != 0;
		captureExcluded = exclude && ok;
		excludeFailure = exclude && !ok
			? "SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) failed (win32 error " + Marshal.GetLastWin32Error() + ")"
			: (exclude ? "" : "capture exclusion was switched off for diagnostics");
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["requested"] = exclude;
		d["captureExcluded"] = captureExcluded;
		d["excludeFailure"] = excludeFailure;
		return d;
	}

	// ---------------------------------------------------------------- commands
	/// <summary>Outline a screen rectangle. `holdMs` hides it automatically.</summary>
	public static Dictionary<string, object> ShowRegion(int x, int y, int width, int height, string label, int holdMs, string theme)
	{
		Ensure();
		if (!running) return NotShown();
		if (width <= 0 || height <= 0) throw new ArgumentException("the capture frame needs a positive rectangle, got " + width + "x" + height);
		requestedTheme = NormalizeTheme(theme);
		ResolveTheme();
		lock (gate) { frameLabel = label == null ? "" : label; }
		SetWindowPos(frameWnd, new IntPtr(-1), x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
		InvalidateRect(frameWnd, IntPtr.Zero, false);
		UpdateWindow(frameWnd);
		frameVisible = true;
		KillTimer(frameWnd, TIMER_FRAME_HOLD);
		if (holdMs > 0) SetTimer(frameWnd, TIMER_FRAME_HOLD, (uint)holdMs, IntPtr.Zero);
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["shown"] = true;
		d["x"] = x; d["y"] = y; d["width"] = width; d["height"] = height;
		d["label"] = frameLabel;
		d["captureExcluded"] = captureExcluded;
		d["holdMs"] = holdMs;
		d["theme"] = resolvedTheme;
		return d;
	}

	public static Dictionary<string, object> HideRegion()
	{
		if (frameWnd != IntPtr.Zero)
		{
			KillTimer(frameWnd, TIMER_FRAME_HOLD);
			ShowWindow(frameWnd, SW_HIDE);
		}
		frameVisible = false;
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["shown"] = false;
		return d;
	}

	/// <summary>Show or refresh the input badge. `holdMs` hides it after the last update.</summary>
	public static Dictionary<string, object> ShowBadge(string message, int holdMs, string theme)
	{
		Ensure();
		if (!running) return NotShown();
		string text = message == null ? "" : message;
		requestedTheme = NormalizeTheme(theme);
		ResolveTheme();
		lock (gate) { badgeText = text; }
		int width;
		int height = 40;
		using (Graphics1 g = new Graphics1(badgeWnd))
		{
			width = Math.Min(760, Math.Max(240, g.Measure(text) + 78));
		}
		RECT work = new RECT();
		SystemParametersInfoW(SPI_GETWORKAREA, 0, ref work, 0);
		int bx = work.Left + ((work.Right - work.Left) - width) / 2;
		int by = work.Bottom - height - 18;
		SetWindowPos(badgeWnd, new IntPtr(-1), bx, by, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
		InvalidateRect(badgeWnd, IntPtr.Zero, false);
		UpdateWindow(badgeWnd);
		badgeVisible = true;
		SetTimer(badgeWnd, TIMER_BADGE_PULSE, 550, IntPtr.Zero);
		KillTimer(badgeWnd, TIMER_BADGE_HIDE);
		if (holdMs > 0) SetTimer(badgeWnd, TIMER_BADGE_HIDE, (uint)holdMs, IntPtr.Zero);
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["shown"] = true;
		d["text"] = text;
		d["x"] = bx; d["y"] = by; d["width"] = width; d["height"] = height;
		d["captureExcluded"] = captureExcluded;
		d["theme"] = resolvedTheme;
		return d;
	}

	public static Dictionary<string, object> HideBadge()
	{
		if (badgeWnd != IntPtr.Zero)
		{
			KillTimer(badgeWnd, TIMER_BADGE_HIDE);
			KillTimer(badgeWnd, TIMER_BADGE_PULSE);
			ShowWindow(badgeWnd, SW_HIDE);
		}
		badgeVisible = false;
		Dictionary<string, object> d = new Dictionary<string, object>();
		d["shown"] = false;
		return d;
	}

	/// <summary>A throwaway DC pair used only to measure text with the indicator font.</summary>
	sealed class Graphics1 : IDisposable
	{
		IntPtr hdc, previous;
		[DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
		[DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

		public Graphics1(IntPtr hwnd) { hdc = GetDC(hwnd); previous = SelectObject(hdc, font); }
		public int Measure(string text)
		{
			if (text.Length == 0) return 0;
			SIZE size;
			if (!GetTextExtentPoint32W(hdc, text, text.Length, out size)) return text.Length * 9;
			return size.cx;
		}
		public void Dispose()
		{
			if (hdc != IntPtr.Zero) { SelectObject(hdc, previous); ReleaseDC(IntPtr.Zero, hdc); hdc = IntPtr.Zero; }
		}
	}

	// ---------------------------------------------------------------- painting
	/// <summary>Both windows share one class; the handle decides which one is painting.</summary>
	static IntPtr SharedProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
	{
		bool isBadge = hwnd == badgeWnd;
		switch (msg)
		{
			case WM_ERASEBKGND:
				return new IntPtr(1);
			case WM_PAINT:
				if (isBadge) PaintBadge(hwnd); else PaintFrame(hwnd);
				return IntPtr.Zero;
			case WM_TIMER:
				long id = wParam.ToInt64();
				if (id == TIMER_FRAME_HOLD.ToInt64())
				{
					KillTimer(hwnd, TIMER_FRAME_HOLD);
					ShowWindow(hwnd, SW_HIDE);
					frameVisible = false;
				}
				else if (id == TIMER_BADGE_HIDE.ToInt64())
				{
					KillTimer(hwnd, TIMER_BADGE_HIDE);
					KillTimer(hwnd, TIMER_BADGE_PULSE);
					ShowWindow(hwnd, SW_HIDE);
					badgeVisible = false;
				}
				else if (id == TIMER_BADGE_PULSE.ToInt64())
				{
					badgePhase = badgePhase == 0 ? 1 : 0;
					InvalidateRect(hwnd, IntPtr.Zero, false);
				}
				return IntPtr.Zero;
		}
		return DefWindowProcW(hwnd, msg, wParam, lParam);
	}

	static void PaintFrame(IntPtr hwnd)
	{
		// Re-resolve on every paint so a Windows theme switch reaches the indicator
		// without anyone having to tell it.
		ResolveTheme();
		PAINTSTRUCT ps;
		IntPtr hdc = BeginPaint(hwnd, out ps);
		try
		{
			RECT rc;
			GetClientRect(hwnd, out rc);
			int w = rc.Right, h = rc.Bottom;
			if (w <= 0 || h <= 0) return;
			// The key colour is what LWA_COLORKEY turns transparent, so the interior
			// shows the desktop and only the border and label are drawn.
			IntPtr matte = CreateSolidBrush(KeyColor);
			FillRect(hdc, ref rc, matte);
			DeleteObject(matte);

			int t = Math.Min(frameThickness, Math.Min(w, h) / 2);
			IntPtr accent = CreateSolidBrush(FrameAccent);
			RECT top = new RECT(); top.Left = 0; top.Top = 0; top.Right = w; top.Bottom = t;
			RECT bottom = new RECT(); bottom.Left = 0; bottom.Top = h - t; bottom.Right = w; bottom.Bottom = h;
			RECT left = new RECT(); left.Left = 0; left.Top = t; left.Right = t; left.Bottom = h - t;
			RECT right = new RECT(); right.Left = w - t; right.Top = t; right.Right = w; right.Bottom = h - t;
			FillRect(hdc, ref top, accent);
			FillRect(hdc, ref bottom, accent);
			FillRect(hdc, ref left, accent);
			FillRect(hdc, ref right, accent);
			DeleteObject(accent);

			string label;
			lock (gate) { label = frameLabel; }
			if (label != null && label.Length > 0 && w > 40 && h > 30)
			{
				IntPtr previousFont = SelectObject(hdc, font);
				SIZE size;
				int textWidth = GetTextExtentPoint32W(hdc, label, label.Length, out size) ? size.cx : label.Length * 9;
				int pad = 10, pillHeight = 24;
				int pillWidth = Math.Min(w - t * 2, textWidth + pad * 2);
				RECT pill = new RECT();
				pill.Left = t; pill.Top = t; pill.Right = t + pillWidth; pill.Bottom = t + pillHeight;
				IntPtr back = CreateSolidBrush(LabelBack);
				IntPtr pen = CreatePen(0, 1, FrameAccent);
				IntPtr oldBrush = SelectObject(hdc, back);
				IntPtr oldPen = SelectObject(hdc, pen);
				RoundRect(hdc, pill.Left, pill.Top, pill.Right, pill.Bottom, 8, 8);
				SelectObject(hdc, oldBrush);
				SelectObject(hdc, oldPen);
				DeleteObject(back);
				DeleteObject(pen);
				SetBkMode(hdc, 1);
				SetTextColor(hdc, LabelText);
				RECT text = new RECT();
				text.Left = pill.Left + pad; text.Top = pill.Top; text.Right = pill.Right - pad; text.Bottom = pill.Bottom;
				DrawTextW(hdc, label, -1, ref text, DT_SINGLELINE | DT_VCENTER | DT_LEFT | DT_NOPREFIX);
				SelectObject(hdc, previousFont);
			}
		}
		finally { EndPaint(hwnd, ref ps); }
	}

	static void PaintBadge(IntPtr hwnd)
	{
		ResolveTheme();
		PAINTSTRUCT ps;
		IntPtr hdc = BeginPaint(hwnd, out ps);
		try
		{
			RECT rc;
			GetClientRect(hwnd, out rc);
			int w = rc.Right, h = rc.Bottom;
			if (w <= 0 || h <= 0) return;
			IntPtr matte = CreateSolidBrush(KeyColor);
			FillRect(hdc, ref rc, matte);
			DeleteObject(matte);

			IntPtr back = CreateSolidBrush(BadgeBack);
			IntPtr edge = CreatePen(0, 1, BadgeEdge);
			IntPtr oldBrush = SelectObject(hdc, back);
			IntPtr oldPen = SelectObject(hdc, edge);
			RoundRect(hdc, 0, 0, w, h, 18, 18);
			SelectObject(hdc, oldBrush);
			SelectObject(hdc, oldPen);
			DeleteObject(back);
			DeleteObject(edge);

			uint dot = badgePhase == 0 ? DotOn : DotOff;
			IntPtr dotBrush = CreateSolidBrush(dot);
			IntPtr dotPen = CreatePen(0, 1, dot);
			oldBrush = SelectObject(hdc, dotBrush);
			oldPen = SelectObject(hdc, dotPen);
			int radius = badgePhase == 0 ? 7 : 5;
			int cy = h / 2, cx = 22;
			Ellipse(hdc, cx - radius, cy - radius, cx + radius, cy + radius);
			SelectObject(hdc, oldBrush);
			SelectObject(hdc, oldPen);
			DeleteObject(dotBrush);
			DeleteObject(dotPen);

			string message;
			lock (gate) { message = badgeText; }
			if (message != null && message.Length > 0)
			{
				IntPtr previousFont = SelectObject(hdc, font);
				SetBkMode(hdc, 1);
				SetTextColor(hdc, BadgeText);
				RECT text = new RECT();
				text.Left = 42; text.Top = 0; text.Right = w - 14; text.Bottom = h;
				DrawTextW(hdc, message, -1, ref text, DT_SINGLELINE | DT_VCENTER | DT_LEFT | DT_NOPREFIX);
				SelectObject(hdc, previousFont);
			}
		}
		finally { EndPaint(hwnd, ref ps); }
	}
}

/// <summary>
/// Terminates this helper when the process that spawned it disappears.
///
/// Closing stdin normally ends the helper, but a parent killed abruptly can leave
/// it alive - and a live helper keeps its indicator windows, so a stale badge
/// would sit on screen and, through the ownership claim, keep the real owner from
/// drawing at all.
/// </summary>
public static class DshWatchdog
{
	public static void WatchParent(int parentPid)
	{
		if (parentPid <= 0) return;
		Thread thread = new Thread(delegate()
		{
			while (true)
			{
				Thread.Sleep(2000);
				try { System.Diagnostics.Process.GetProcessById(parentPid); }
				catch { Environment.Exit(0); }
			}
		});
		thread.IsBackground = true;
		thread.Start();
	}
}
