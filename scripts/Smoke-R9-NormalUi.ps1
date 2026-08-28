param([int]$ProcessId = 12800, [string]$OldName = 'arr_r8_hot', [string]$NewName = 'arr_r9_first')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CKR9SmokeMouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    public static void DoubleClick(int x, int y) {
        SetCursorPos(x, y);
        mouse_event(2, 0, 0, 0, UIntPtr.Zero);
        mouse_event(4, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(100);
        mouse_event(2, 0, 0, 0, UIntPtr.Zero);
        mouse_event(4, 0, 0, 0, UIntPtr.Zero);
    }
}
'@

$process = Get-Process -Id $ProcessId
$root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
$nameProperty = [System.Windows.Automation.AutomationElement]::NameProperty
$typeProperty = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$tree = [System.Windows.Automation.TreeScope]::Descendants
$name = [System.Windows.Automation.PropertyCondition]::new($nameProperty, $OldName)
$field = $root.FindFirst($tree, $name)
if (-not $field) { throw "Field not found: $OldName" }
$rect = $field.Current.BoundingRectangle
[CKR9SmokeMouse]::DoubleClick([int]($rect.Left + $rect.Width / 2), [int]($rect.Top + $rect.Height / 2))
Start-Sleep -Milliseconds 250
$editType = [System.Windows.Automation.PropertyCondition]::new($typeProperty, [System.Windows.Automation.ControlType]::Edit)
$edits = $root.FindAll($tree, $editType)
$edit = $null
for ($i = 0; $i -lt $edits.Count; $i++) {
    if ($edits.Item($i).Current.ClassName -eq 'blocklyHtmlInput') { $edit = $edits.Item($i); break }
}
if (-not $edit) { throw 'Blockly editor not found' }
$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($NewName)
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 500
$newNameCondition = [System.Windows.Automation.PropertyCondition]::new($nameProperty, $NewName)
if (-not $root.FindFirst($tree, [System.Windows.Automation.Condition]$newNameCondition)) { throw 'Field edit did not commit' }
$compileName = [System.Windows.Automation.PropertyCondition]::new($nameProperty, '编译')
$button = $root.FindFirst($tree, $compileName)
if (-not $button) { throw 'Compile button not found' }
$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
$watch = [Diagnostics.Stopwatch]::StartNew()
$busy = $false
$joined = ''
for ($i = 0; $i -lt 500; $i++) {
    Start-Sleep -Milliseconds 100
    $texts = $root.FindAll($tree, [System.Windows.Automation.PropertyCondition]::new($typeProperty, [System.Windows.Automation.ControlType]::Text))
    $joined = ($texts | ForEach-Object { $_.Current.Name }) -join "`n"
    $button = $root.FindFirst($tree, $compileName)
    if ($button -and -not $button.Current.IsEnabled) { $busy = $true }
    if ($busy -and $button -and $button.Current.IsEnabled -and $joined -match '编译成功，用时') { break }
}
$watch.Stop()
$pattern = 'Timing|NativeRelink|Exact Match|Build Engine|编译成功|Runtime tool|migration|Arduino CLI child|baseline'
$lines = $joined -split "`r?`n" | Where-Object { $_ -match $pattern } | Select-Object -Unique | Select-Object -Last 100
[pscustomobject]@{ WallMs = $watch.ElapsedMilliseconds; BusyObserved = $busy; Lines = ($lines -join "`n") } | ConvertTo-Json -Depth 3
