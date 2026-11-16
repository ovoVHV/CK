param([Parameter(Mandatory=$true)][string]$File,[Parameter(Mandatory=$true)][long]$WriteTime)
$ErrorActionPreference='Stop'
[IO.File]::SetLastWriteTimeUtc($File,[DateTime]::FromFileTimeUtc($WriteTime))
