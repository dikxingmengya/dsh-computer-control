# dsh-computer-control native helper.
#
# A long-lived process spawned once by the Node side of the plugin. It speaks
# newline-delimited JSON on stdin/stdout: one request object per line in, one
# response object per line out. Nothing else may ever reach stdout.
#
#   --> {"id":7,"op":"mouse.click","args":{"x":100,"y":200}}
#   <-- {"id":7,"ok":true,"result":{"x":100,"y":200,"button":"left","count":1}}
#
# Keeping the process resident is what makes this usable: Add-Type compilation
# and the DPI/awareness handshake are paid once instead of on every action.
#
# `-ParentPid` is the process that spawned this helper. A watchdog exits when it
# disappears, so an abruptly killed parent cannot leave a helper - and its
# on-screen indicator - behind.
param([int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'

# The protocol is UTF-8 in both directions; window titles and typed text are
# routinely non-ASCII and would otherwise be mangled.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

$script:HelperVersion = '1.0.0'
$script:ScriptRoot = $PSScriptRoot
$script:OcrReady = $null
$script:AsTaskGeneric = $null

function Out-Line([object]$payload) {
	$json = $payload | ConvertTo-Json -Depth 24 -Compress
	[Console]::Out.WriteLine($json)
	[Console]::Out.Flush()
}

function Get-Arg($a, [string]$name, $default) {
	if ($null -eq $a) { return $default }
	$prop = $a.PSObject.Properties[$name]
	if ($null -eq $prop) { return $default }
	if ($null -eq $prop.Value) { return $default }
	return $prop.Value
}

function Get-IntArg($a, [string]$name, [int]$default) {
	$v = Get-Arg $a $name $null
	if ($null -eq $v) { return $default }
	return [int]$v
}

function Get-StrArg($a, [string]$name, [string]$default) {
	$v = Get-Arg $a $name $null
	if ($null -eq $v) { return $default }
	return [string]$v
}

# ------------------------------------------------------------------ native load
function Initialize-Native {
	$sources = @('native.cs', 'overlay.cs') | ForEach-Object { Join-Path $script:ScriptRoot $_ }
	foreach ($source in $sources) {
		if (-not (Test-Path $source)) { throw "a native source file is missing beside the helper: $source" }
	}
	$cacheDir = Join-Path $script:ScriptRoot '.cache'
	if (-not (Test-Path $cacheDir)) { $null = New-Item -ItemType Directory -Path $cacheDir -Force }

	# The cache file is named after the source content rather than overwritten in
	# place: another helper process (a second session, or one still running the
	# previous generation) keeps the old assembly mapped and locked, and a fixed
	# name would make every rebuild fail with "file in use".
	$sha = [System.Security.Cryptography.SHA256]::Create()
	try {
		$joined = ($sources | ForEach-Object { [System.IO.File]::ReadAllBytes($_) }) | ForEach-Object { $_ }
		$digest = $sha.ComputeHash([byte[]]$joined)
		$key = ([BitConverter]::ToString($digest) -replace '-', '').Substring(0, 16)
	} finally { $sha.Dispose() }
	$dll = Join-Path $cacheDir "native-$key.dll"

	$rebuilt = $false
	if (-not (Test-Path $dll)) {
		$tmp = Join-Path $cacheDir "native-$key.building.dll"
		if (Test-Path $tmp) { Remove-Item $tmp -Force }
		Add-Type -Path $sources -ReferencedAssemblies System.Drawing -OutputAssembly $tmp
		try {
			Move-Item -Path $tmp -Destination $dll -Force
		} catch {
			# Another process won the race and is holding the final name; its copy is
			# byte-identical, so load from ours and leave the cache alone.
			$dll = $tmp
		}
		$rebuilt = $true
		# Retire generations that are no longer referenced, ignoring ones still locked.
		Get-ChildItem -Path $cacheDir -Filter 'native-*.dll' |
			Where-Object { $_.FullName -ne $dll } |
			ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch { } }
	}
	Add-Type -Path $dll
	$mode = [DshNat]::Init()
	return @{ dpiMode = $mode; rebuilt = $rebuilt; dll = $dll; key = $key }
}

# ------------------------------------------------------------------ OCR (WinRT)
function Initialize-Ocr {
	if ($null -ne $script:OcrReady) { return $script:OcrReady }
	$script:OcrReady = @{ available = $false; reason = ''; languages = @() }
	try {
		Add-Type -AssemblyName System.Runtime.WindowsRuntime
		$script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
			$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
		})[0]
		if ($null -eq $script:AsTaskGeneric) { throw 'the WinRT AsTask bridge is unavailable in this PowerShell host' }
		$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
		$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
		$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
		$langs = @()
		foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) { $langs += $l.LanguageTag }
		$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
		if ($null -eq $engine) {
			if ($langs.Count -gt 0) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($langs[0])) }
		}
		if ($null -eq $engine) {
			$script:OcrReady = @{ available = $false; reason = 'no OCR language pack is installed for this user profile'; languages = $langs }
			return $script:OcrReady
		}
		$script:OcrReady = @{ available = $true; reason = ''; languages = $langs }
	} catch {
		$script:OcrReady = @{ available = $false; reason = $_.Exception.Message; languages = @() }
	}
	return $script:OcrReady
}

function Invoke-Await($op, [Type]$type) {
	$asTask = $script:AsTaskGeneric.MakeGenericMethod($type)
	$task = $asTask.Invoke($null, @($op))
	$null = $task.Wait(-1)
	return $task.Result
}

function Invoke-OcrImage([string]$path, [int]$originX, [int]$originY, [double]$scaleToScreen) {
	$state = Initialize-Ocr
	if (-not $state.available) { throw "OCR is unavailable: $($state.reason)" }
	$file = Invoke-Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
	$stream = Invoke-Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
	try {
		$decoder = Invoke-Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
		$bitmap = Invoke-Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
		$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
		if ($null -eq $engine -and $state.languages.Count -gt 0) {
			$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($state.languages[0]))
		}
		if ($null -eq $engine) { throw 'no OCR engine could be created' }
		$result = Invoke-Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
		$lines = @()
		foreach ($line in $result.Lines) {
			$words = @()
			$minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
			foreach ($w in $line.Words) {
				$r = $w.BoundingRect
				if ($r.X -lt $minX) { $minX = $r.X }
				if ($r.Y -lt $minY) { $minY = $r.Y }
				if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
				if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
				$words += @{
					text = $w.Text
					x = [int][Math]::Round($originX + $r.X * $scaleToScreen)
					y = [int][Math]::Round($originY + $r.Y * $scaleToScreen)
					width = [int][Math]::Round($r.Width * $scaleToScreen)
					height = [int][Math]::Round($r.Height * $scaleToScreen)
				}
			}
			$lines += @{
				text = $line.Text
				x = [int][Math]::Round($originX + $minX * $scaleToScreen)
				y = [int][Math]::Round($originY + $minY * $scaleToScreen)
				width = [int][Math]::Round(($maxX - $minX) * $scaleToScreen)
				height = [int][Math]::Round(($maxY - $minY) * $scaleToScreen)
				centerX = [int][Math]::Round($originX + (($minX + $maxX) / 2) * $scaleToScreen)
				centerY = [int][Math]::Round($originY + (($minY + $maxY) / 2) * $scaleToScreen)
				words = $words
			}
		}
		return @{ lines = $lines; text = ($lines | ForEach-Object { $_.text }) -join "`n"; languages = $state.languages }
	} finally { $script:AsTaskGeneric = $script:AsTaskGeneric; $stream.Dispose() }
}

# ------------------------------------------------------------------ window waits
function Wait-Window([string]$selector, [int]$timeoutMs, [string]$condition) {
	$deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
	$last = $null
	while ($true) {
		$found = $null
		if ($selector -eq '' -or $selector -eq 'foreground') {
			$found = [DshWin]::Foreground()
			if ($condition -eq 'exists' -and $null -ne $found.hwnd) { return @{ satisfied = $true; waited = $true; window = $found } }
		} else {
			$hwnd = [DshWin]::Resolve($selector)
			if ($hwnd -ne [IntPtr]::Zero) {
				if ($condition -eq 'exists') {
					return @{ satisfied = $true; waited = $true; hwnd = ('0x' + $hwnd.ToInt64().ToString('X')) }
				}
				$fg = [DshWin]::Foreground()
				if ($condition -eq 'foreground' -and $fg.hwnd -eq ('0x' + $hwnd.ToInt64().ToString('X'))) {
					return @{ satisfied = $true; waited = $true; window = $fg }
				}
			}
		}
		$last = [DshWin]::Foreground()
		if ([DateTime]::UtcNow -ge $deadline) {
			return @{ satisfied = $false; waited = $true; condition = $condition; selector = $selector; foreground = $last }
		}
		Start-Sleep -Milliseconds 120
	}
}

# ------------------------------------------------------------------ dispatcher
function Invoke-Op([string]$op, $a) {
	switch ($op) {
		'ping' {
			return @{ pong = $true; pid = $PID; version = $script:HelperVersion; dpiMode = $script:NativeInfo.dpiMode; psVersion = $PSVersionTable.PSVersion.ToString(); sta = ([Threading.Thread]::CurrentThread.GetApartmentState().ToString()) }
		}
		'screen.info' {
			return @{
				dpiMode = $script:NativeInfo.dpiMode
				virtualScreen = [DshNat]::VirtualScreen()
				monitors = [DshNat]::Monitors()
				cursor = [DshNat]::CursorPos()
				foreground = [DshWin]::Foreground()
				windowCount = ([DshWin]::Windows($true, '', '', '')).Count
			}
		}
		'screen.capture' {
			return [DshNat]::Capture(
				(Get-IntArg $a 'x' 0), (Get-IntArg $a 'y' 0),
				(Get-IntArg $a 'width' 0), (Get-IntArg $a 'height' 0),
				(Get-StrArg $a 'hwnd' ''), (Get-IntArg $a 'maxDim' 0),
				(Get-Arg $a 'scale' 0.0), (Get-StrArg $a 'format' 'png'),
				(Get-IntArg $a 'quality' 85), (Get-StrArg $a 'out' ''))
		}
		'screen.pixel' { return [DshNat]::Pixel((Get-IntArg $a 'x' 0), (Get-IntArg $a 'y' 0)) }
		'screen.findColor' {
			return [DshNat]::FindColor(
				(Get-IntArg $a 'x' 0), (Get-IntArg $a 'y' 0), (Get-IntArg $a 'width' 0), (Get-IntArg $a 'height' 0),
				(Get-IntArg $a 'r' 0), (Get-IntArg $a 'g' 0), (Get-IntArg $a 'b' 0),
				(Get-IntArg $a 'tolerance' 16), (Get-IntArg $a 'step' 1), (Get-IntArg $a 'maxResults' 20))
		}
		'screen.findImage' {
			return [DshNat]::FindImage(
				(Get-StrArg $a 'template' ''), (Get-IntArg $a 'x' 0), (Get-IntArg $a 'y' 0),
				(Get-IntArg $a 'width' 0), (Get-IntArg $a 'height' 0),
				(Get-Arg $a 'threshold' 0.85), (Get-IntArg $a 'tolerance' 24),
				(Get-IntArg $a 'maxResults' 5), (Get-IntArg $a 'step' 1))
		}
		'window.list' {
			return @{ windows = [DshWin]::Windows(
					(Get-Arg $a 'visibleOnly' $true), (Get-StrArg $a 'title' ''),
					(Get-StrArg $a 'class' ''), (Get-StrArg $a 'process' '')) }
		}
		'window.foreground' { return [DshWin]::Foreground() }
		'window.op' {
			$selector = Get-StrArg $a 'selector' ''
			$wop = Get-StrArg $a 'action' ''
			$a1 = Get-IntArg $a 'x' 0
			$a2 = Get-IntArg $a 'y' 0
			$a3 = Get-IntArg $a 'width' 0
			$a4 = Get-IntArg $a 'height' 0
			if ($wop -eq 'topmost') {
				$a1 = 0
				if ((Get-Arg $a 'topmost' $false) -eq $true) { $a1 = 1 }
			}
			return [DshWin]::WindowOp($wop, $selector, $a1, $a2, $a3, $a4)
		}
		'window.wait' {
			return Wait-Window (Get-StrArg $a 'selector' '') (Get-IntArg $a 'timeoutMs' 5000) (Get-StrArg $a 'condition' 'exists')
		}
		'mouse.move' { return [DshWin]::MouseMove((Get-IntArg $a 'x' 0), (Get-IntArg $a 'y' 0), (Get-IntArg $a 'durationMs' 0)) }
		'mouse.position' { return [DshNat]::CursorPos() }
		'mouse.click' {
			$hasPos = $false
			if ($null -ne $a -and $null -ne $a.PSObject.Properties['x']) { $hasPos = $true }
			return [DshWin]::MouseClick((Get-StrArg $a 'button' 'left'), (Get-IntArg $a 'count' 1), (Get-IntArg $a 'x' 0), (Get-IntArg $a 'y' 0), $hasPos)
		}
		'mouse.button' { return [DshWin]::MouseButton((Get-StrArg $a 'action' 'down'), (Get-StrArg $a 'button' 'left')) }
		'mouse.drag' {
			return [DshWin]::MouseDrag(
				(Get-IntArg $a 'fromX' 0), (Get-IntArg $a 'fromY' 0),
				(Get-IntArg $a 'toX' 0), (Get-IntArg $a 'toY' 0),
				(Get-StrArg $a 'button' 'left'), (Get-IntArg $a 'durationMs' 300))
		}
		'mouse.scroll' {
			$horizontal = $false
			if ((Get-Arg $a 'horizontal' $false) -eq $true) { $horizontal = $true }
			# `lines` is the honest unit: one wheel notch is 120, and how far that travels is a
			# system setting the caller cannot know. The count of notches is worked out here,
			# against the setting the machine actually has.
			if ($null -ne (Get-Arg $a 'lines' $null)) {
				return [DshWin]::MouseScrollLines((Get-IntArg $a 'lines' 0), $horizontal)
			}
			return [DshWin]::MouseScroll((Get-IntArg $a 'delta' 0), $horizontal)
		}
		'key.type' { return [DshWin]::KeyType((Get-StrArg $a 'text' ''), (Get-IntArg $a 'delayMs' 0)) }
		'key.press' { return [DshWin]::KeyPress((Get-StrArg $a 'key' ''), (Get-StrArg $a 'action' 'press'), (Get-IntArg $a 'repeat' 1)) }
		'key.hotkey' { return [DshWin]::KeyHotkey((Get-StrArg $a 'hotkey' '')) }
		'key.vk' { return [DshWin]::KeyVk((Get-IntArg $a 'vk' 0), (Get-StrArg $a 'action' 'press')) }
		'app.launch' {
			$target = Get-StrArg $a 'target' ''
			if ($target -eq '') { throw 'target is required' }
			$params = @{ FilePath = $target; PassThru = $true }
			$argList = Get-StrArg $a 'arguments' ''
			if ($argList -ne '') { $params['ArgumentList'] = $argList }
			$workdir = Get-StrArg $a 'workdir' ''
			if ($workdir -ne '') { $params['WorkingDirectory'] = $workdir }
			$verb = Get-StrArg $a 'verb' ''
			if ($verb -ne '') { $params['Verb'] = $verb }
			$proc = Start-Process @params
			if ($null -eq $proc) { return @{ launched = $true; pid = 0; target = $target; note = 'handed to the shell; no process handle was returned (typical for URLs and documents)' } }
			return @{ launched = $true; pid = $proc.Id; name = $proc.ProcessName; target = $target }
		}
		'app.list' {
			$filter = Get-StrArg $a 'filter' ''
			$items = @()
			foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
				$handle = 0
				$title = ''
				try { $handle = [int64]$p.MainWindowHandle; $title = [string]$p.MainWindowTitle } catch { continue }
				if ($handle -eq 0) { continue }
				if ($filter -ne '' -and $p.ProcessName -notmatch $filter -and $title -notmatch $filter) { continue }
				$items += @{
					pid = $p.Id
					name = $p.ProcessName
					title = $title
					hwnd = ('0x' + $handle.ToString('X'))
					responding = $p.Responding
					startedAt = $(try { $p.StartTime.ToString('o') } catch { $null })
				}
			}
			return @{ count = $items.Count; processes = $items }
		}
		'app.kill' {
			$procId = Get-IntArg $a 'pid' 0
			$name = Get-StrArg $a 'name' ''
			if ($procId -le 0 -and $name -eq '') { throw 'either pid or name is required' }
			if ($procId -gt 0) {
				$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
				if ($null -ne $p) {
					Stop-Process -Id $procId -Force -ErrorAction Stop
					return @{ killed = $true; pid = $procId; name = $p.ProcessName }
				}
				# Packaged apps (Notepad on Windows 11) are started by a launcher whose
				# pid exits immediately, so a gone pid with a name still means "try the name".
				if ($name -eq '') { return @{ killed = $false; alreadyGone = $true; pid = $procId } }
			}
			# A process that already exited satisfies the caller's intent; only a real
			# refusal to stop it is an error.
			$targets = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
			if ($targets.Count -eq 0) { return @{ killed = $false; alreadyGone = $true; name = $name; pid = $procId } }
			$killed = @()
			foreach ($p in $targets) { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $killed += $p.Id }
			return @{ killed = $true; name = $name; pids = $killed }
		}
		'clip.get' { return @{ text = [DshWin]::ClipGet() } }
		'clip.set' { return [DshWin]::ClipSet((Get-StrArg $a 'text' '')) }
		'sys.op' { return [DshWin]::SystemOp((Get-StrArg $a 'action' '')) }
		'record.start' { return [DshHook]::Start() }
		'record.stop' { return [DshHook]::Stop() }
		'record.status' { return @{ recording = [DshHook]::Recording } }
		'ocr.status' {
			$s = Initialize-Ocr
			return @{ available = $s.available; reason = $s.reason; languages = $s.languages; engine = 'Windows.Media.Ocr' }
		}
		'ocr.image' {
			return Invoke-OcrImage (Get-StrArg $a 'path' '') (Get-IntArg $a 'originX' 0) (Get-IntArg $a 'originY' 0) (Get-Arg $a 'scaleToScreen' 1.0)
		}
		'sleep' { Start-Sleep -Milliseconds (Get-IntArg $a 'ms' 0); return @{ sleptMs = (Get-IntArg $a 'ms' 0) } }
		'overlay.status' { return [DshOverlay]::Status() }
		'overlay.start' {
			$claim = $true
			if ((Get-Arg $a 'claim' $true) -eq $false) { $claim = $false }
			return [DshOverlay]::Start($claim)
		}
		'overlay.stop' { return [DshOverlay]::Stop() }
		'overlay.region' {
			return [DshOverlay]::ShowRegion(
				(Get-IntArg $a 'x' 0), (Get-IntArg $a 'y' 0),
				(Get-IntArg $a 'width' 0), (Get-IntArg $a 'height' 0),
				(Get-StrArg $a 'label' ''), (Get-IntArg $a 'holdMs' 0), (Get-StrArg $a 'theme' ''))
		}
		'overlay.region.hide' { return [DshOverlay]::HideRegion() }
		'overlay.badge' { return [DshOverlay]::ShowBadge((Get-StrArg $a 'text' ''), (Get-IntArg $a 'holdMs' 0), (Get-StrArg $a 'theme' '')) }
		'overlay.badge.hide' { return [DshOverlay]::HideBadge() }
		'overlay.affinity' {
			$exclude = $true
			if ((Get-Arg $a 'exclude' $true) -eq $false) { $exclude = $false }
			return [DshOverlay]::SetCaptureExclusion($exclude)
		}
		default { throw "unknown op: $op" }
	}
}

# ------------------------------------------------------------------ main loop
$script:NativeInfo = Initialize-Native
if ($ParentPid -gt 0) { [DshWatchdog]::WatchParent($ParentPid) }
Out-Line @{ id = 0; ok = $true; result = @{ hello = $true; version = $script:HelperVersion; dpiMode = $script:NativeInfo.dpiMode; pid = $PID; parentPid = $ParentPid } }

while ($true) {
	$line = [Console]::In.ReadLine()
	if ($null -eq $line) { break }
	if ($line.Trim().Length -eq 0) { continue }
	$id = 0
	try {
		$req = $line | ConvertFrom-Json
		$id = Get-IntArg $req 'id' 0
		$result = Invoke-Op (Get-StrArg $req 'op' '') (Get-Arg $req 'args' $null)
		Out-Line @{ id = $id; ok = $true; result = $result }
	} catch {
		$msg = $_.Exception.Message
		$inner = $_.Exception.InnerException
		if ($null -ne $inner) { $msg = "$msg :: $($inner.Message)" }
		Out-Line @{ id = $id; ok = $false; error = $msg; errorType = $_.Exception.GetType().Name }
	}
}
