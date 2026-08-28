param([int]$ProcessId = 13220, [string]$ProjectName = 'ove')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CKRecentProjectMouse {
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
$name = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty, $ProjectName)
$item = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $name)
if (-not $item) { throw "Recent project not found: $ProjectName" }
$item.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView()
Start-Sleep -Milliseconds 200
$rect = $item.Current.BoundingRectangle
[CKRecentProjectMouse]::DoubleClick(
    [int]($rect.Left + $rect.Width / 2),
    [int]($rect.Top + $rect.Height / 2))
Start-Sleep -Seconds 2
"opened=$ProjectName"
