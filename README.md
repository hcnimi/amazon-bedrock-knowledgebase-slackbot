# Amazon Bedrock Knowledge Base Slack Chat Bot

This CDK project installs an AWS API GW and AWS Lambda that acts as a Slack Bot integration to forward user questions from Slack Bot (Slash command) queries to an AWS Bedrock Knowledge base. The CDK here also deploy's the Bedrock Knowledge base, a vector database using AWS Opensearch serverless (AOSS) and creates an AOSS index via a custom resource.

In this example a Bedrock Knowledge base has been populated with all of the public documentation of AWS Well-Architected Framework and the SlackBot has been given a Slash Command function /blog-bot. Here, it’s expected that the users can use the  /blog-bot command from within Slack to ask AWS design, architecture, security and other best practice related questions. 

### Enable Amazon Bedrock Model Access
Enable [https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html](Amazon Bedrock Model Access) for the RAG query models intended to use in the Knowledge base. Here for example, I have enabled all of the Anthropic Claude3 models.  

### Populate Amazon Bedrock Knowledge Base
Populate the deployed knowledge base with your documents and information. In this example I have populated with all of the public documentation of AWS Well-Architected Framework.
[https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-create.html](Amazon Bedrock Knowledge Base)

### Build the Slack Bot with Slack Command:
You will first need to create the SlackBot and retrieve the **SLACK_SIGNING_SECRET** and **SLACK_BOT_TOKEN**.

### Install and Test using AWS CDK:

* Clone this repo and CD into dir:  
```
git clone git@ssh.gitlab.aws.dev:dcolcott/amazon-bedrock-knowledgebase-slackbot.git
cd amazon-bedrock-knowledgebase-slackbot
```

* Install Typescript and CDK if not on local system:
```
npm -g install aws-cdk typescript
```

* Update Required Parameters:

in **lib/amazon-bedrock-knowledgebase-slackbot-stack.ts** update the parameters at the top of the code:

i.e: Example Params:
```
RAG_MODEL_ID = "anthropic.claude-3-sonnet-20240229-v1:0"
SLACK_SLASH_COMMAND = "/ask-aws"
SLACK_SIGNING_SECRET = "819ceacb626ba46d2e8ad132a37a5b4f" **update with unique slack signing secret**
SLACK_BOT_TOKEN = "xoxb-1225118050611-6978847875861-toXVlbYNgLGR9nAnmoJ7yH6t" **update  with unique slack bot token**
EMBEDDING_MODEL = "amazon.titan-embed-text-v1"
COLLECTION_NAME = 'slack-bedrock-vector-db'
VECTOR_INDEX_NAME = 'slack-bedrock-os-index'
BEDROCK_KB_NAME = 'slack-bedrockkb'
BEDROCK_KB_DATA_SOURCE = 'slack-bedrockkb-ds'
```

* Install and Build the project
```
npm install
npm run build
```

* Deploy the CDK to your AWS Account . Region as specified by local credentials. 
```
cdk deploy
```

### Get the AWS API Gateway prod staging URL. 

* In the AWS console go to the CloudFormation service and find the stack named: **AmazonBedrockKnowledgebaseSlackbotStack**  
* In the **Outputs** section, get the prod staging URL titled BedrockKbSlackbotApiEndpoint...   
i.e: https://40f879zil5.execute-api.us-east-1.amazonaws.com/prod/

The Slack Bot slash command asks for a **Request URL**. Here, the URL will be as above appended with /slack/[SLASH-COMMAND]  

And so, for the slash command '/blog-bot', the **Request URL** will be:  
https://40f879zil5.execute-api.us-east-1.amazonaws.com/prod/slack/blog-bot

