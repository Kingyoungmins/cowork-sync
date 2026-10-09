# Keeps Windows from sleeping for at most 14 h while overnight experiments run. Changes no settings; stop by ending this process.
Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[W.P]::SetThreadExecutionState(0x80000001) | Out-Null   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
Start-Sleep -Seconds 50400
[W.P]::SetThreadExecutionState(0x80000000) | Out-Null
