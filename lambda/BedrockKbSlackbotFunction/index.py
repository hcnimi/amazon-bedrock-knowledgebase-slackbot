# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0.
#

'''
AWS Lambda hosted Slack ChatBot integration to Amazon Bedrock Knowledge Base. 
Expects Slack Bot Slash Command given by the SLACK_SLASH_COMMAND param and presents 
a user query to the Bedrock Knowledge Base described by the KNOWLEDGEBASE_ID parameter.

The user query is used in a Bedrock KB ReteriveandGenerate API call and the KB 
response is presented to the user in Slack.

Slack integration based on SlackBolt library and examples given at:
https://github.com/slackapi/bolt-python/blob/main/examples/aws_lambda/lazy_aws_lambda.py
 '''
 
__version__ = "0.0.1"
__status__ = "Development"
__copyright__ = "Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved."
__author__ = "Dean Colcott <https://www.linkedin.com/in/deancolcott/>"

import os
import json
import boto3
import logging
from slack_bolt import App
from slack_bolt.adapter.aws_lambda import SlackRequestHandler

# process_before_response must be True when running on Lambda
app = App(
  token=os.environ.get("SLACK_BOT_TOKEN"),
  signing_secret=os.environ.get("SLACK_SIGNING_SECRET"),
  process_before_response=True)

# Get the expected slack and AWS account params to local vars. 
SLACK_SLASH_COMMAND = os.environ['SLACK_SLASH_COMMAND']
KNOWLEDGEBASE_ID = os.environ['KNOWLEDGEBASE_ID'] 
RAG_MODEL_ID = os.environ['RAG_MODEL_ID'] 
AWS_REGION = os.environ['AWS_REGION']
GUARD_RAIL_ID = os.environ['GUARD_RAIL_ID']
GUARD_VERSION = os.environ['GUARD_RAIL_VERSION']

print(f'GR_ID,{GUARD_RAIL_ID}')
print(f'GR_V, {GUARD_VERSION}')

@app.middleware
def log_request(logger, body, next):
  '''
    SlackBolt library logging. 
  '''
  logger.debug(body)
  return next()

def respond_to_slack_within_3_seconds(body, ack):
  '''
    Slack Bot Slash Command requires an Ack response within 3 seconds or it 
    messages an operation timeout error to the user in the chat thread. 

    The SlackBolt library provides a Async Ack function then re-invokes this Lambda 
    to LazyLoad the process_command_request command that calls the Bedrock KB ReteriveandGenerate API.

    This function is called initially to acknowledge the Slack Slash command within 3 secs. 
  '''
  try:
    user_query = body["text"]
    logging.info(f"${SLACK_SLASH_COMMAND} - Acknowledging command: {SLACK_SLASH_COMMAND} - User Query: {user_query}\n")
    ack(f"\n${SLACK_SLASH_COMMAND} - Processing Request: {user_query}")

  except Exception as err:
    print(f"${SLACK_SLASH_COMMAND} - Error: {err}")
    respond(f"${SLACK_SLASH_COMMAND} - Sorry an error occurred. Please try again later. Error: {err}")

def process_command_request(respond, body):
  '''
    Receive the Slack Slash Command user query and proxy the query to Bedrock Knowledge base ReteriveandGenerate API 
    and return the response to Slack to be presented in the users chat thread. 
  '''
  try:
    # Get the user query
    user_query = body["text"]
    logging.info(f"${SLACK_SLASH_COMMAND} - Responding to command: {SLACK_SLASH_COMMAND} - User Query: {user_query}")

    kb_response = get_bedrock_knowledgebase_response(user_query)
    response_text = kb_response["output"]["text"]
    respond(f"\n${SLACK_SLASH_COMMAND} - Response: {response_text}\n")
  
  except Exception as err:
    print(f"${SLACK_SLASH_COMMAND} - Error: {err}")
    respond(f"${SLACK_SLASH_COMMAND} - Sorry an error occurred. Please try again later. Error: {err}")

def get_bedrock_knowledgebase_response(user_query):
  '''
    Get and return the Bedrock Knowledge Base ReteriveAndGenerate response.
    Do all init tasks here instead of globally as initial invocation of this lambda
    provides Slack required ack in 3 sec. It doesn't trigger any bedrock functions and is 
    time sensitive. 
  '''

  # Initialise the bedrock-runtime client (in default / running region).
  client = boto3.client(
    service_name='bedrock-agent-runtime',
    region_name=AWS_REGION
  )

  #Create the RetrieveAndGenerateCommand input with the user query.
  input =  { 
      "text": user_query
    }

  config = {
    "type" : "KNOWLEDGE_BASE",
    "knowledgeBaseConfiguration": {
        "generationConfiguration": {
            "guardrailConfiguration": {
                "guardrailId": GUARD_RAIL_ID,
                "guardrailVersion": GUARD_VERSION
            },
        },
        "knowledgeBaseId": KNOWLEDGEBASE_ID,
        "modelArn": RAG_MODEL_ID
   }
  }

  response = client.retrieve_and_generate(
    input=input, retrieveAndGenerateConfiguration=config
  )
  logging.info(f"Bedrock Knowledge Base Response: {response}")
  return response

# Init the Slack Slash '/' command handler.
app.command(SLACK_SLASH_COMMAND)(ack=respond_to_slack_within_3_seconds, lazy=[process_command_request])

# Init the Slack Bolt logger and log handlers. 
SlackRequestHandler.clear_all_log_handlers()
logging.basicConfig(format="%(asctime)s %(message)s", level=logging.DEBUG)

# Lambda handler method.
def handler(event, context):
  print(f"${SLACK_SLASH_COMMAND} - Event: {event}\n")
  slack_handler = SlackRequestHandler(app=app)
  return slack_handler.handle(event, context)