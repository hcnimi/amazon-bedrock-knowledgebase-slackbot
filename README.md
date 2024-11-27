# Amazon Bedrock Knowledge Base Slack Chat Bot

This project deploys a Slack ChatBot integration to a managed RAG service provided by Amazon Bedrock Knowledge base. All resources are deployed and managed using the AWS Cloud Development Kit (CDK). In this solution, an AWS API Gateway and AWS Lambda provide an interface to an Amazon Bedrock Knowledge base consisting of a vector database using AWS Opensearch serverless (AOSS) and an AOSS index via a custom resource. 

The Slack integration is provided through the [Slack Bolt Library for Python](https://slack.dev/bolt-python/) running in the Request Processor Lambda function. The Slack Bolt Library handles authentication and permissions to the Slack application. Slack Bolt provides a [dedicated user guide](https://slack.dev/bolt-js/deployments/aws-lambda/) to deploy and run the library in a Lambda function.

![Slack AWS Architecture](images/slack-aws-architecture.png)

A detailed guide to deploy the project and the Slack App are given in the AWS blog: [Create a generative AI assistant with Slack and Amazon Bedrock](https://aws.amazon.com/blogs/machine-learning/create-a-generative-ai-assistant-with-slack-and-amazon-bedrock/).

In this example, the Bedrock Knowledge base is populated with all of the public documentation of the [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html). The SlackBot has been given a Slash Command function /ask-aws where users are able to ask any AWS design, architecture, security and other best practice related questions.

# Giving Feedback and Contributions

* [Contributions Guidelines](https://github.com/aws-samples/amazon-bedrock-knowledgebase-slackbot/blob/main/CONTRIBUTING.md)
    Submit Issues, Feature Requests or Bugs

# Code of Conduct
This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct). For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact opensource-codeofconduct@amazon.com with any additional questions or comments.

# Security

See [Security Issue Notifications](https://github.com/aws-samples/amazon-bedrock-knowledgebase-slackbot/blob/main/CONTRIBUTING.md#security-issue-notifications) for more information.

# License
This library is licensed under the MIT-0 License. See the [LICENSE](https://github.com/aws-samples/amazon-bedrock-knowledgebase-slackbot/blob/main/LICENSE) file.