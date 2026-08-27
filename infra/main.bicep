param location string = resourceGroup().location
param containerAppEnvironmentName string
param containerAppName string
param containerImage string
param containerRegistryServer string = ''
param containerRegistryUsername string = ''
@secure()
param containerRegistryPassword string = ''
@secure()
param databaseUrl string
@secure()
param directUrl string = ''
@secure()
param redisUrl string
@secure()
param jwtSecret string
@secure()
param geminiApiKey string
@secure()
param supabaseServiceRoleKey string
param supabaseUrl string
param supabaseAnonKey string
@secure()
param simliApiKey string
param simliApiBaseUrl string = 'https://api.simli.ai'
param simliAvatarId string
param simliVoiceId string = 'Default'
@secure()
param paymentWebhookAuthSecret string
@secure()
param paddleApiKey string = ''
@secure()
param paddleNotificationWebhookSecret string = ''
param paddleEnv string = 'production'
param paddleProPriceId string = ''
param paddleTopUp50PriceId string = ''
param paddleTopUp100PriceId string = ''
param paddleCheckoutUrl string = ''
@secure()
param googlePlayServiceAccountJson string = ''
param googlePlayRtdnAudience string = ''
param googlePlayRtdnServiceAccountEmail string = ''
@secure()
param appleRootCertificatesBase64 string = ''
param appleAppId string = ''
@secure()
param metricsAuthToken string = ''
@secure()
param retentionJobSecret string = ''
@secure()
param resendApiKey string = ''
param authEmailFrom string = ''
param mobileAppScheme string = 'mentomobile'

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${containerAppEnvironmentName}-logs'
  location: location
  properties: {
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppEnvironmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspace.properties.customerId
        sharedKey: logAnalyticsWorkspace.listKeys().primarySharedKey
      }
    }
  }
}

resource voiceApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      secrets: [
        {
          name: 'database-url'
          value: databaseUrl
        }
        {
          name: 'direct-url'
          value: directUrl
        }
        {
          name: 'jwt-secret'
          value: jwtSecret
        }
        {
          name: 'redis-url'
          value: redisUrl
        }
        {
          name: 'gemini-api-key'
          value: geminiApiKey
        }
        {
          name: 'supabase-service-role-key'
          value: supabaseServiceRoleKey
        }
        {
          name: 'simli-api-key'
          value: simliApiKey
        }
        {
          name: 'payment-webhook-auth-secret'
          value: paymentWebhookAuthSecret
        }
        {
          name: 'paddle-api-key'
          value: paddleApiKey
        }
        {
          name: 'paddle-webhook-secret'
          value: paddleNotificationWebhookSecret
        }
        {
          name: 'google-play-service-account-json'
          value: googlePlayServiceAccountJson
        }
        {
          name: 'apple-root-certificates-base64'
          value: appleRootCertificatesBase64
        }
        {
          name: 'registry-password'
          value: containerRegistryPassword
        }
        {
          name: 'metrics-auth-token'
          value: metricsAuthToken
        }
        {
          name: 'retention-job-secret'
          value: retentionJobSecret
        }
        {
          name: 'resend-api-key'
          value: resendApiKey
        }
      ]
      registries: empty(containerRegistryServer) ? [] : [
        {
          server: containerRegistryServer
          username: containerRegistryUsername
          passwordSecretRef: 'registry-password'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'mento-voice-server'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/api/live'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 24
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/live'
                port: 3000
              }
              initialDelaySeconds: 15
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/ready'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'DIRECT_URL'
              secretRef: 'direct-url'
            }
            {
              name: 'JWT_SECRET'
              secretRef: 'jwt-secret'
            }
            {
              name: 'REDIS_URL'
              secretRef: 'redis-url'
            }
            {
              name: 'REDIS_CLUSTER_MODE'
              value: 'true'
            }
            {
              name: 'REQUIRE_REALTIME_REDIS'
              value: 'true'
            }
            {
              name: 'REQUIRE_RATE_LIMIT_REDIS'
              value: 'true'
            }
            {
              name: 'GEMINI_API_KEY'
              secretRef: 'gemini-api-key'
            }
            {
              name: 'SUPABASE_URL'
              value: supabaseUrl
            }
            {
              name: 'SUPABASE_ANON_KEY'
              value: supabaseAnonKey
            }
            {
              name: 'SUPABASE_SERVICE_ROLE_KEY'
              secretRef: 'supabase-service-role-key'
            }
            {
              name: 'SIMLI_API_KEY'
              secretRef: 'simli-api-key'
            }
            {
              name: 'SIMLI_API_BASE_URL'
              value: simliApiBaseUrl
            }
            {
              name: 'SIMLI_AVATAR_ID'
              value: simliAvatarId
            }
            {
              name: 'SIMLI_VOICE_ID'
              value: simliVoiceId
            }
            {
              name: 'PAYMENT_WEBHOOK_AUTH_SECRET'
              secretRef: 'payment-webhook-auth-secret'
            }
            {
              name: 'PADDLE_ENV'
              value: paddleEnv
            }
            {
              name: 'PADDLE_API_KEY'
              secretRef: 'paddle-api-key'
            }
            {
              name: 'PADDLE_NOTIFICATION_WEBHOOK_SECRET'
              secretRef: 'paddle-webhook-secret'
            }
            {
              name: 'PADDLE_PRO_PRICE_ID'
              value: paddleProPriceId
            }
            {
              name: 'PADDLE_TOP_UP_50_PRICE_ID'
              value: paddleTopUp50PriceId
            }
            {
              name: 'PADDLE_TOP_UP_100_PRICE_ID'
              value: paddleTopUp100PriceId
            }
            {
              name: 'PADDLE_CHECKOUT_URL'
              value: paddleCheckoutUrl
            }
            {
              name: 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'
              secretRef: 'google-play-service-account-json'
            }
            {
              name: 'GOOGLE_PLAY_RTDN_AUDIENCE'
              value: googlePlayRtdnAudience
            }
            {
              name: 'GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL'
              value: googlePlayRtdnServiceAccountEmail
            }
            {
              name: 'APPLE_ROOT_CERTIFICATES_BASE64'
              secretRef: 'apple-root-certificates-base64'
            }
            {
              name: 'APPLE_APP_ID'
              value: appleAppId
            }
            {
              name: 'METRICS_AUTH_TOKEN'
              secretRef: 'metrics-auth-token'
            }
            {
              name: 'RETENTION_JOB_SECRET'
              secretRef: 'retention-job-secret'
            }
            {
              name: 'RESEND_API_KEY'
              secretRef: 'resend-api-key'
            }
            {
              name: 'AUTH_EMAIL_FROM'
              value: authEmailFrom
            }
            {
              name: 'MOBILE_APP_SCHEME'
              value: mobileAppScheme
            }
          ]
        }
      ]
      scale: {
        // Gemini Live sessions are held in this Node process, so replicas cannot share them.
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output containerAppFqdn string = voiceApp.properties.configuration.ingress.fqdn
output containerAppId string = voiceApp.id
