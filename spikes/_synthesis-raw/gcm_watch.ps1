# Spike-0 (6): does Git Credential Manager keep working non-interactively over many hours? (v2: exit code captured before trimming output)
$env:GIT_TERMINAL_PROMPT = "0"; $env:GCM_INTERACTIVE = "never"
$log = Join-Path $env:COWORK_SCRATCH "overnight\gcm_watch.log"   # <scratch>\overnight\gcm_watch.log
"# v2 restarted $(Get-Date -Format o); earlier lines' exit=-1 came from Select-Object stopping the pipeline, not from git" | Out-File -Append -Encoding utf8 $log
for ($i = 0; $i -lt 90; $i++) {
  $t0 = Get-Date
  $out = (& git ls-remote https://github.com/Kingyoungmins/cowork-sync-sandbox.git refs/heads/main 2>&1 | Out-String)
  $code = $LASTEXITCODE
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  $first = ($out -split "`n")[0].Trim() -replace '[0-9a-f]{40}','<oid>'
  "{0:o}`tv2-{1}`texit={2}`t{3}ms`t{4}" -f (Get-Date), $i, $code, $ms, $first | Out-File -Append -Encoding utf8 $log
  Start-Sleep -Seconds 600
}
