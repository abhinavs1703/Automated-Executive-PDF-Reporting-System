$summary = @'
ExecuBrief — current project summary

Single application entry point:
  npm start

Local dashboard:
  http://127.0.0.1:3000/

Setup (Node.js 24.x required):
  npm ci
  if (!(Test-Path .env)) { Copy-Item .env.example .env }
  node scripts/init-demo.js
  npm test
  npm start

The browser dashboard uses synthetic demo SQLite data and real PDF generation.
Public demo routes never send email or invoke the scheduler. The private reporting
API remains separate and token-protected in production. This script writes a status
summary only; it does not initialize, reset, seed, or modify databases.

Current audit and evidence:
  docs/PROJECT_AUDIT.md
  docs/IMPLEMENTATION_STATUS.md
  docs/DEPLOYMENT.md
'@
$summaryPath = Join-Path $PSScriptRoot 'summary.txt'
Set-Content -Path $summaryPath -Value $summary -Encoding utf8
Write-Output $summary
