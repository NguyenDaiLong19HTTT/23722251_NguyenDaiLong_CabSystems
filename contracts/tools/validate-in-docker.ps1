param([string]$DockerExecutable = 'docker')

# Contract checker only: no CAB services, secrets, socket or writable source mount.
# Use an executable path argument if Docker is not in the terminal PATH.
$ErrorActionPreference = 'Stop'
$contractRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$apiRoot = (Resolve-Path (Join-Path $contractRoot '..\API-Document')).Path
$checkerImage = 'python@sha256:adafcc17694d715c905b4c7bebd96907a1fd5cf183395f0ebc4d3428bd22d92d'
# exec is needed to load pip-installed native .so modules; data stays ephemeral.
$checkerArgs = @(
    'run', '--rm', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '1g',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=512m',
    '--mount', "type=bind,source=$contractRoot,target=/work/contracts,readonly",
    '--mount', "type=bind,source=$apiRoot,target=/work/API-Document,readonly",
    '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'PYTHONPATH=/tmp/deps', '-w', '/work',
    $checkerImage, 'sh', '-c',
    'python -m pip install --quiet --root-user-action=ignore --disable-pip-version-check --no-cache-dir --target /tmp/deps -r contracts/tools/requirements.txt && python contracts/tools/validate.py'
)
& $DockerExecutable @checkerArgs
if ($LASTEXITCODE -ne 0) { throw "Contract checker exited with code $LASTEXITCODE" }
