#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';

import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';


import { AmazonBedrockKnowledgebaseSlackbotStack } from '../lib/amazon-bedrock-knowledgebase-slackbot-stack';

const app = new cdk.App();
new AmazonBedrockKnowledgebaseSlackbotStack(app, 'AmazonBedrockKnowledgebaseSlackbotStack', {});

Aspects.of(app).add(new AwsSolutionsChecks());