param(
  [string]$Tag = 'phase1'
)

$workspaceRoot = $PSScriptRoot
$dockerfile = Join-Path $PSScriptRoot 'Dockerfile'
$image = "mentomentoregistry.azurecr.io/mento:$Tag"

az acr login --name mentomentoregistry
if ($LASTEXITCODE -ne 0) { throw 'Azure Container Registry login failed.' }

docker build --file $dockerfile --tag $image $workspaceRoot
if ($LASTEXITCODE -ne 0) { throw 'Docker build failed.' }

docker push $image
if ($LASTEXITCODE -ne 0) { throw 'Docker push failed.' }

az containerapp update --name mento-backend --resource-group mento-prod --subscription 5138f566-7c56-4809-8e57-c889e5241121 --image $image
if ($LASTEXITCODE -ne 0) { throw 'Azure Container App update failed.' }
