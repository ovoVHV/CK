param([Parameter(Mandatory)][string]$Installer,[Parameter(Mandatory)][string]$ExtractTo)
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$version=(Get-Content -Raw -LiteralPath "$repo/package.json"|ConvertFrom-Json).version
$file=Get-Item -LiteralPath $Installer
if($file.Name -cne "CK-V$version-Setup-x64.exe" -or $file.VersionInfo.FileVersion -ne $version -or $file.VersionInfo.ProductVersion -ne $version){throw 'Installer identity mismatch'}
if(Test-Path -LiteralPath $ExtractTo){throw 'Extraction requires a fresh directory'}
& "$env:ProgramFiles/7-Zip/7z.exe" x $file.FullName "-o$ExtractTo" '-xr!$PLUGINSDIR' -y -bso0
if($LASTEXITCODE){throw 'Cannot extract installer'}
$root=(Get-Item -LiteralPath $ExtractTo).FullName
$rows=Get-Content -Raw -LiteralPath "$root/files.sha256.json"|ConvertFrom-Json
$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach($row in $rows){
 $path=[IO.Path]::GetFullPath([IO.Path]::Combine($root,$row.path))
 if(!$path.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) -or !$seen.Add($path)){throw 'Invalid payload manifest'}
 $item=Get-Item -LiteralPath $path
 if($item.Length -ne $row.bytes -or (Get-FileHash -LiteralPath $path).Hash -ne $row.sha256){throw "Invalid payload: $($row.path)"}
 if($row.path.StartsWith('engine\src\') -and (Get-FileHash -LiteralPath (Join-Path $repo $row.path.Substring(7))).Hash -ne $row.sha256){throw "Controller differs from checkout: $($row.path)"}
}
foreach($rel in 'package.json','config.example.json','runtime-versions.json'){
 $record=Get-Content -Raw -LiteralPath "$root/engine/$rel"|ConvertFrom-Json
 if($record.version -ne $version -and $record.engineVersion -ne $version){throw "Invalid version in $rel"}
}
if((Get-Item -LiteralPath "$root/desktop/CK-V9-Preview.exe").VersionInfo.ProductVersion -ne $version){throw 'Incorrect desktop version'}
[pscustomobject]@{version=$version;files=$rows.Count;sha256=(Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant();bytes=$file.Length;authenticode=(Get-AuthenticodeSignature -LiteralPath $file.FullName).Status.ToString()}
