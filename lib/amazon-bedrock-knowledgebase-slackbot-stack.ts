// # Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// # SPDX-License-Identifier: MIT-0.

// '''
// AWS Lambda hosted Slack ChatBot integration to Amazon Bedrock Knowledge Base.
// Supporting Bedrock Knowledge Base with Opensearch as the Vector DB
// Expects Slack Bot Slash Command given by the SLACK_SLASH_COMMAND param and presents 

// The user query is used in a Bedrock KB ReteriveandGenerate API call and the KB 
// response is presented to the user in Slack.

// Slack integration based on SlackBolt library and examples given at:
// https://github.com/slackapi/bolt-python/blob/main/examples/aws_lambda/lazy_aws_lambda.py
 
// __version__ = "0.0.1"
// __status__ = "Development"
// __copyright__ = "Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved."
// __author__ = "Barry Conway <https://www.linkedin.com/in/baconway/>"
// __author__ = "Dean Colcott <https://www.linkedin.com/in/deancolcott/>"

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { execSync } from 'child_process';

// Import L2 constructs
import * as iam from 'aws-cdk-lib/aws-iam';
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as ops from 'aws-cdk-lib/aws-opensearchserverless';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';

// RAG Query MODEL_ID (Update dependent on model access and AWS Regional Support):
// Amazon Titan Models: "amazon.titan-text-premier-v1:0"
// Anthropic Claude2  Models:  "anthropic.claude-instant-v1" || "anthropic.claude-v2:1"
// Anthropic Claude3  Models:  "anthropic.claude-3-haiku-20240307-v1:0" || "anthropic.claude-3-sonnet-20240229-v1:0" || "anthropic.claude-3-5-sonnet-20240620-v1:0" 
const RAG_MODEL_ID = "anthropic.claude-3-sonnet-20240229-v1:0";

// RAG Embeddings Model ID (Update dependent on model access and AWS Regional Support):
// Amazon Titan Embedding: "amazon.titan-embed-text-v1" || "amazon.titan-embed-text-v2:0"
// Cohere Embedding: "cohere.embed-english-v3" // Note: Needs dimension value updated to 1024 in Vector DB.
const EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";

// Update only to suit custom Slack apps - no change needed for demo.
const SLACK_SLASH_COMMAND = "/ask-aws";
const COLLECTION_NAME = 'slack-bedrock-vector-db';
const VECTOR_INDEX_NAME = 'slack-bedrock-os-index';
const BEDROCK_KB_NAME = 'slack-bedrock-kb';
const BEDROCK_KB_DATA_SOURCE = 'slack-bedrock-kb-ds';
const LAMBDA_MEMORY_SIZE = 265;

// AWS Account params. 
const AWS_ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT;

export class AmazonBedrockKnowledgebaseSlackbotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get secrets from context or fail if not provided
    const slackBotToken = this.node.tryGetContext('slackBotToken') || process.env.SLACK_BOT_TOKEN;
    const slackSigningSecret = this.node.tryGetContext('slackSigningSecret') || process.env.SLACK_SIGNING_SECRET;

    if (!slackBotToken || !slackSigningSecret) {
      throw new Error('Missing required context variables. Please provide slackBotToken and slackSigningSecret');
    }

    // Create secrets in Secrets Manager
    const slackBotTokenSecret = new secretsmanager.Secret(this, 'SlackBotTokenSecret', {
      secretName: '/slack/bot-token',
      description: 'Slack Bot User OAuth Token',
      secretStringValue: cdk.SecretValue.unsafePlainText(JSON.stringify({
        token: slackBotToken
      }))
    });

    const slackBotSigningSecret = new secretsmanager.Secret(this, 'SlackBotSigningSecret', {
      secretName: '/slack/signing-secret',
      description: 'Slack Signing Secret',
      secretStringValue: cdk.SecretValue.unsafePlainText(JSON.stringify({
        secret: slackSigningSecret
      }))
    });

    // Create SSM parameters that reference the secrets
    const botTokenParameter = new ssm.StringParameter(this, 'SlackBotTokenParameter', {
      parameterName: '/slack/bot-token/parameter',
      stringValue: `{{resolve:secretsmanager:${slackBotTokenSecret.secretName}}}`,
      description: 'Reference to Slack Bot Token in Secrets Manager',
      tier: ssm.ParameterTier.STANDARD
    });

    const signingSecretParameter = new ssm.StringParameter(this, 'SlackSigningSecretParameter', {
      parameterName: '/slack/signing-secret/parameter',
      stringValue: `{{resolve:secretsmanager:${slackBotSigningSecret.secretName}}}`,
      description: 'Reference to Slack Signing Secret in Secrets Manager',
      tier: ssm.ParameterTier.STANDARD
    });

    // define an s3 bucket
    const s3Bucket = new s3.Bucket(this, 'kb-bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, 
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true, enforceSSL: true,
    });
    NagSuppressions.addResourceSuppressions(s3Bucket, [
      { id: 'AwsSolutions-S1', reason: 'S3 access logging not required for sample code' }
    ]);

    // Create an IAM policy for S3 access
    const s3AccessListPolicy = new PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [s3Bucket.bucketArn],
    });
    s3AccessListPolicy.addCondition("StringEquals", {"aws:ResourceAccount": AWS_ACCOUNT});

    // Create an IAM policy for S3 access
    const s3AccessGetPolicy = new iam.PolicyStatement({
      actions: ['s3:GetObject','s3:Delete*'],
      resources: [`${s3Bucket.bucketArn}/*`],
    });
    s3AccessGetPolicy.addCondition("StringEquals", {"aws:ResourceAccount": AWS_ACCOUNT});

    // Create an IAM policy to invoke Bedrock models and access titan v1 embedding model
    const bedrockExecutionRolePolicy = new PolicyStatement();
    bedrockExecutionRolePolicy.addActions("bedrock:InvokeModel");
    bedrockExecutionRolePolicy.addResources(`arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/${EMBEDDING_MODEL}`);

    // Create an IAM policy to delete Bedrock knowledgebase
    const bedrockKBDeleteRolePolicy = new PolicyStatement();
    bedrockKBDeleteRolePolicy.addActions("bedrock:Delete*");
    bedrockKBDeleteRolePolicy.addResources(`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`);

    // Create IAM policy to call OpensearchServerless
    const BedrockOSSPolicyForKnowledgeBase = new PolicyStatement();
    BedrockOSSPolicyForKnowledgeBase.addActions("aoss:APIAccessAll");
    BedrockOSSPolicyForKnowledgeBase.addActions("aoss:DeleteAccessPolicy","aoss:DeleteCollection","aoss:DeleteLifecyclePolicy","aoss:DeleteSecurityConfig","aoss:DeleteSecurityPolicy");
    BedrockOSSPolicyForKnowledgeBase.addResources(`arn:aws:aoss:${this.region}:${this.account}:collection/*`);

    // Define IAM Role and add Iam policies for bedrock execution role
    const bedrockExecutionRole = new iam.Role(this, 'BedrockExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });
    bedrockExecutionRole.addToPolicy(bedrockExecutionRolePolicy);
    bedrockExecutionRole.addToPolicy(BedrockOSSPolicyForKnowledgeBase);
    bedrockExecutionRole.addToPolicy(s3AccessListPolicy);
    bedrockExecutionRole.addToPolicy(s3AccessGetPolicy);
    bedrockExecutionRole.addToPolicy(bedrockKBDeleteRolePolicy);

    // Create bedrock Guardrails for the slack bot
    const Guardrail = new bedrock.CfnGuardrail(this, 'MyGuardrail', {
      blockedInputMessaging: 'Sorry, the Ask AWS Well Architected slack bot cannot provide a response for this question',
      blockedOutputsMessaging: 'Sorry, the Ask AWS Well Architected slack bot cannot provide a response for this question',
      name: 'slack-bedrock-guardrail',
      description: 'Bedrock Guardrails for Slack bedrock bot',
    
      contentPolicyConfig: {
        filtersConfig: [
          {
              'type': 'SEXUAL',
              'inputStrength': 'HIGH',
              'outputStrength': 'HIGH'
          },
          {
              'type': 'VIOLENCE',
              'inputStrength': 'HIGH',
              'outputStrength': 'HIGH'
          },
          {
              'type': 'HATE',
              'inputStrength': 'HIGH',
              'outputStrength': 'HIGH'
          },
          {
              'type': 'INSULTS',
              'inputStrength': 'HIGH',
              'outputStrength': 'HIGH'
          },
          {
              'type': 'MISCONDUCT',
              'inputStrength': 'HIGH',
              'outputStrength': 'HIGH'
          },
          {
              'type': 'PROMPT_ATTACK',
              'inputStrength': 'HIGH',
              'outputStrength': 'NONE'
          }
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [{
          'type': 'EMAIL',
          'action': 'ANONYMIZE'
        },
        {
          'type': 'PHONE',
          'action': 'ANONYMIZE'
        },
        {
          'type': 'NAME',
          'action': 'ANONYMIZE'
        },
        {
          'type': 'CREDIT_DEBIT_CARD_NUMBER',
          'action': 'BLOCK'
        }],
      },
      wordPolicyConfig: {
        managedWordListsConfig: [{
          type: 'PROFANITY',
        }],
      },
    });

    const GuardrailVersion = new bedrock.CfnGuardrailVersion(this, 'MyGuardrailVersion', {
      guardrailIdentifier: Guardrail.attrGuardrailId, //guardrailIdentifier
      description: 'v1.0',
    });

    //Define vars for Guardrail ID and version for the Retrieve&Generate API call
    const GUARD_RAIL_ID = Guardrail.attrGuardrailId
    const GUARD_RAIL_VERSION = GuardrailVersion.attrVersion
    
    //Define OpenSearchServerless Collection & depends on policies
    const osCollection = new ops.CfnCollection(this, 'osCollection', {
      name: COLLECTION_NAME,
      description: 'Slack bedrock vector db',
      type: 'VECTORSEARCH'
    });

    // Define AOSS vector DB encryption policy with AWSOwned key true
    const aossEncryptionPolicy = new ops.CfnSecurityPolicy(this, 'aossEncryptionPolicy', {
      name: "bedrock-kb-encryption-policy",
      type: "encryption",
      policy: JSON.stringify({
        Rules: [
          {
            ResourceType: 'collection',
            Resource: [`collection/${COLLECTION_NAME}`]
          }
        ],
        AWSOwnedKey: true
      }),
    });
    osCollection.addDependency(aossEncryptionPolicy);

    // Define Vector DB network policy with AllowFromPublic true. include collection & dashboard
    const aossNetworkPolicy = new ops.CfnSecurityPolicy(this, 'aossNetworkPolicy', {
      name: 'bedrock-kb-network-policy',
      type: 'network',
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${COLLECTION_NAME}`],
            },
            {
              ResourceType: 'dashboard',
              Resource: [`collection/${COLLECTION_NAME}`],
            },
          ],
          AllowFromPublic: true,
        },
      ]),
    });
    osCollection.addDependency(aossNetworkPolicy);

    // Define createIndexFunction execution role and policy. Managed role 'AWSLambdaBasicExecutionRole'
    const createIndexFunctionRole = new iam.Role(this, 'CreateIndexFunctionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    createIndexFunctionRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'));
    createIndexFunctionRole.addToPolicy(new PolicyStatement({
      actions: [
        'aoss:APIAccessAll',
        'aoss:DescribeIndex',
        'aoss:ReadDocument',
        'aoss:CreateIndex',
        'aoss:DeleteIndex',
        'aoss:UpdateIndex',
        'aoss:WriteDocument',
        'aoss:CreateCollectionItems',
        'aoss:DeleteCollectionItems',
        'aoss:UpdateCollectionItems',
        'aoss:DescribeCollectionItems'
      ],
      resources: [
        `arn:aws:aoss:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:collection/*`,
        `arn:aws:aoss:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:index/*`
      ],
      effect: iam.Effect.ALLOW,
    }));

    // Define a lambda function to create an opensearch serverless index
    const createIndexFunction = new lambda.Function(this, 'CreateIndexFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset('lambda/CreateIndexFunction'),
      environment: {
        "INDEX_NAME": osCollection.attrId,
      },
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(1),
      role: createIndexFunctionRole
    });

    // Define OpenSearchServerless access policy to access the index and collection from the Amazon Bedrock execution role and the lambda execution role
    const aossAccessPolicy = new ops.CfnAccessPolicy(this, 'aossAccessPolicy', {
      name: 'bedrock-kb-access-policy',
      type: 'data',
      policy: JSON.stringify([
        {
        Rules: [
          {
            ResourceType: "collection",
            Resource: [`collection/*`],
            Permission: ["aoss:*"],
          },
          {
            ResourceType: 'index',
            Resource: [`index/*/*`],
            Permission: ['aoss:*'],
          },
        ],
        // Add principal of bedrock execution role and lambda execution role
        Principal: [
          bedrockExecutionRole.roleArn,
          createIndexFunction.role?.roleArn,
          `arn:aws:iam::${this.account}:root`
        ],
      }
    ]),
    });
    //this.serverlessCollection = osCollection;
    osCollection.addDependency(aossAccessPolicy);
    
    const Endpoint = `${osCollection.attrId}.${cdk.Stack.of(this).region}.aoss.amazonaws.com`;

    const vectorIndex = new cr.AwsCustomResource(this, 'vectorIndex', {
      installLatestAwsSdk: true,
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: createIndexFunction.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            RequestType: 'Create',
            CollectionName: osCollection.name,
            IndexName: VECTOR_INDEX_NAME,
            Endpoint: Endpoint,
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('vectorIndex'),
      },
      onDelete: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: createIndexFunction.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            RequestType: 'Delete',
            CollectionName: osCollection.name,
            IndexName: VECTOR_INDEX_NAME,
            Endpoint: Endpoint,
          }),
        },
        //physicalResourceId: cr.PhysicalResourceId.of('vectorIndexResource'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [createIndexFunction.functionArn],
        }),
      ]),
      timeout: cdk.Duration.seconds(60),
    });

    // Ensure vectorIndex depends on collection
    vectorIndex.node.addDependency(osCollection);
    vectorIndex.node.addDependency(aossAccessPolicy);
    vectorIndex.node.addDependency(aossNetworkPolicy);
    vectorIndex.node.addDependency(aossEncryptionPolicy);

    // Define a Bedrock knowledge base with type opensearch serverless and titan for embedding model
    const bedrockkb = new bedrock.CfnKnowledgeBase(this, 'bedrockkb', {
      name: BEDROCK_KB_NAME,
      description: 'bedrock knowledge base for aws',
      roleArn: bedrockExecutionRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/${EMBEDDING_MODEL}`
        },
      },
      storageConfiguration: {
        type: 'OPENSEARCH_SERVERLESS',
        opensearchServerlessConfiguration: {
          collectionArn: osCollection.attrArn, 
          fieldMapping: {
            vectorField: 'bedrock-knowledge-base-default-vector',
            textField: 'AMAZON_BEDROCK_TEXT_CHUNK',
            metadataField: 'AMAZON_BEDROCK_METADATA'
          },
          vectorIndexName: VECTOR_INDEX_NAME
        },
      },
    });
    // add a dependency for bedrock kb on the custom resource. Enables vector index to be created before KB
    bedrockkb.node.addDependency(vectorIndex)
    bedrockkb.node.addDependency(createIndexFunction)
    bedrockkb.node.addDependency(osCollection)
    bedrockkb.node.addDependency(bedrockExecutionRole)

    const apiGatewayLoggingRole = new iam.Role(this, 'ApiGatewayLoggingRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    
    // Add inline policy with specific permissions
    const loggingPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:DescribeLogGroups',
        'logs:DescribeLogStreams',
        'logs:PutLogEvents',
        'logs:GetLogEvents',
        'logs:FilterLogEvents'
      ],
      resources: [
        `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/apigateway/`,
        `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/apigateway/*`,
        `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/apigateway/*:log-stream:*`
      ]
    });

    apiGatewayLoggingRole.addToPolicy(loggingPolicy);

    NagSuppressions.addResourceSuppressions(apiGatewayLoggingRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'API Gateway needs wildcard permissions to create and manage CloudWatch log groups dynamically'
      }
    ], true);
    // Update API Gateway Account settings
    const apiGatewayAccount = new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGatewayLoggingRole.roleArn
    });

    // Define a bedrock knowledge base data source with S3 bucket
    const bedrockKbDataSource = new bedrock.CfnDataSource(this, 'bedrockKbDataSource', {
      name: BEDROCK_KB_DATA_SOURCE,
      knowledgeBaseId: bedrockkb.attrKnowledgeBaseId,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: s3Bucket.bucketArn
        }
      }
    });

    // Add dependency to ensure role is created first
    apiGatewayAccount.node.addDependency(apiGatewayLoggingRole);
    
    // Create an IAM policy to allow the lambda to invoke models in Amazon Bedrock
    const lambdaBedrockModelPolicy = new PolicyStatement()
    lambdaBedrockModelPolicy.addActions("bedrock:InvokeModel")
    lambdaBedrockModelPolicy.addResources(`arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/${RAG_MODEL_ID}`)

    // Create an IAM policy to allow the lambda to call Retrieve and Retrieve and Generate on a Bedrock Knowledge Base 
    const lambdaBedrockKbPolicy = new PolicyStatement();
    lambdaBedrockKbPolicy.addActions("bedrock:Retrieve");
    lambdaBedrockKbPolicy.addActions("bedrock:RetrieveAndGenerate");
    lambdaBedrockKbPolicy.addResources(`arn:aws:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:knowledge-base/${bedrockkb.attrKnowledgeBaseId}`);

    // Create an IAM policy to allow the lambda to call SSM
    const lambdaSSMPolicy = new PolicyStatement();
    lambdaSSMPolicy.addActions("ssm:GetParameter");
    //lambdaSSMPolicy.addActions("ssm:GetParameters");
    // lambdaSSMPolicy.addResources("botTokenParameter.parameterArn");
    // lambdaSSMPolicy.addResources("signingBotSecretParameter.parameterArn");
    lambdaSSMPolicy.addResources(`arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${botTokenParameter.parameterName}`);
    lambdaSSMPolicy.addResources(`arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${signingSecretParameter.parameterName}`);
    
    //arn:aws:ssm:us-east-1:859498851685:parameter/slack/bot-token/parameter
    //"arn:aws:ssm:us-east-2:123456789012:parameter/prod-*"
    //(`arn:aws:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:knowledge-base/${bedrockkb.attrKnowledgeBaseId}`);
  
    const lambdaReinvokePolicy = new PolicyStatement();
    lambdaReinvokePolicy.addActions("lambda:InvokeFunction");
    lambdaReinvokePolicy.addResources(`arn:aws:lambda:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:function:AmazonBedrock*`);

    const lambdaGRinvokePolicy = new PolicyStatement();
    lambdaGRinvokePolicy.addActions("bedrock:ApplyGuardrail");
    lambdaGRinvokePolicy.addResources(`arn:aws:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:guardrail/*`);

    // Create the SlackDot (slash command) integration to Amazon Bedrock Knowledge base responses. 
    const bedrockKbSlackbotFunction = new lambda.Function(this, 'BedrockKbSlackbotFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      memorySize: LAMBDA_MEMORY_SIZE,
      environment: {
        "RAG_MODEL_ID": RAG_MODEL_ID,
        "SLACK_SLASH_COMMAND": SLACK_SLASH_COMMAND,
        "KNOWLEDGEBASE_ID": bedrockkb.attrKnowledgeBaseId,
        // "SLACK_BOT_TOKEN": SLACK_BOT_TOKEN,
        // "SLACK_SIGNING_SECRET": SLACK_SIGNING_SECRET,
        "SLACK_BOT_TOKEN_PARAMETER": botTokenParameter.parameterName,
        "SLACK_SIGNING_SECRET_PARAMETER": signingSecretParameter.parameterName,
        "GUARD_RAIL_ID": GUARD_RAIL_ID,
        "GUARD_RAIL_VERSION": GUARD_RAIL_VERSION,
        "AWS_ACCOUNT": AWS_ACCOUNT!
      },
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/BedrockKbSlackbotFunction', {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [],
          local: {
            tryBundle(outputDir: string) {
              try {
                execSync('pip3 --version');
              } catch {
                return false;
              }

              const commands = [
                `cd lambda/BedrockKbSlackbotFunction`,
                `pip3 install -r requirements.txt -t ${outputDir}`,
                `cp -a . ${outputDir}`
              ];

              execSync(commands.join(' && '));
              return true;
            }
          }
        }
      }),
      timeout: cdk.Duration.minutes(5)
    });

     // Grant the Lambda function permission to read the secrets
     slackBotTokenSecret.grantRead(bedrockKbSlackbotFunction);
     slackBotSigningSecret.grantRead(bedrockKbSlackbotFunction);

    // Attach listed IAM policies to the Lambda functions Execution role
    bedrockKbSlackbotFunction.addToRolePolicy(lambdaBedrockModelPolicy)
    bedrockKbSlackbotFunction.addToRolePolicy(lambdaBedrockKbPolicy)
    bedrockKbSlackbotFunction.addToRolePolicy(lambdaReinvokePolicy)
    bedrockKbSlackbotFunction.addToRolePolicy(lambdaGRinvokePolicy)
    bedrockKbSlackbotFunction.addToRolePolicy(lambdaSSMPolicy)

    // Define the API Gateway resource and associate the trigger for Industrial Query Lambda function
    const bedrockKbSlackbotApi = new apigateway.LambdaRestApi(this, 'BedrockKbSlackbotApi', {
      handler: bedrockKbSlackbotFunction,
      deployOptions: {
        accessLogDestination: new apigateway.LogGroupLogDestination(new logs.LogGroup(this, 'BedrockKbSlackbotApiLogGroup')),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        })
      },
      proxy: false
    });

    // Define the '/industrial/query' API resource with a POST method
    const bedrockKbSlackbotResource = bedrockKbSlackbotApi.root.addResource('slack').addResource('ask-aws');
    bedrockKbSlackbotResource.addMethod('POST')

    // CDK NAG Suppression Rules - IAM
    //============================================
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        '/AmazonBedrockKnowledgebaseSlackbotStack/BedrockExecutionRole/DefaultPolicy/Resource',
        '/AmazonBedrockKnowledgebaseSlackbotStack/CreateIndexFunctionRole/DefaultPolicy/Resource',
        '/AmazonBedrockKnowledgebaseSlackbotStack/BedrockKbSlackbotFunction/ServiceRole/DefaultPolicy/Resource',
        '/AmazonBedrockKnowledgebaseSlackbotStack/CreateIndexFunctionRole/Resource',
        '/AmazonBedrockKnowledgebaseSlackbotStack/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource',
        '/AmazonBedrockKnowledgebaseSlackbotStack/BedrockKbSlackbotFunction/ServiceRole/Resource'
      ],
      [
        { id: 'AwsSolutions-IAM5', reason: 'IAM policy ARN limits actions to the AWS Account and AWS Service with conditions' },
        { id: 'AwsSolutions-IAM4', reason: 'IAM managed policies used for sample/demo code' }
      ]
    );

    // CDK NAG Suppression Rules - Secrets Manager
    //============================================
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        '/AmazonBedrockKnowledgebaseSlackbotStack/SlackBotTokenSecret/Resource',
        '/AmazonBedrockKnowledgebaseSlackbotStack/SlackBotSigningSecret/Resource',
      ],
      [
        { id: 'AwsSolutions-SMG4', reason: 'Secret rotation is not possible in this case' },
      ]
    );

    // CDK NAG Suppression Rules - API GW
    //============================================
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        '/AmazonBedrockKnowledgebaseSlackbotStack/BedrockKbSlackbotApi/Resource',
        '/AmazonBedrockKnowledgebaseSlackbotStack/BedrockKbSlackbotApi/DeploymentStage.prod/Resource',
        '/AmazonBedrockKnowledgebaseSlackbotStack/BedrockKbSlackbotApi/DeploymentStage.prod/Resource',
        '/AmazonBedrockKnowledgebaseSlackbotStack/BedrockKbSlackbotApi/Default/slack/ask-aws/POST/Resource',
        '/AmazonBedrockKnowledgebaseSlackbotStack/BedrockKbSlackbotApi/Default/slack/ask-aws/POST/Resource',
      ],
      [
        { id: 'AwsSolutions-APIG2', reason: 'API validation is not required for demo/sample code' },
        { id: 'AwsSolutions-APIG3', reason: 'AWS WAF is not required for sample/demo code' },
        { id: 'AwsSolutions-APIG6', reason: 'Logging is enabled for the API' },
        { id: 'AwsSolutions-APIG4', reason: 'API Auth is not provided in demo/sample code' },
        { id: 'AwsSolutions-COG4', reason: 'Cognito is not being used in the sample code' }
      ]
    );

}
}
