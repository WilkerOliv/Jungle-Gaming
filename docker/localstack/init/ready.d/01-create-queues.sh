#!/bin/sh
set -eu
awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'
DLQ_ARN="$(awslocal sqs get-queue-attributes --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'
REDRIVE="$(python3 -c 'import json,sys; print(json.dumps({"deadLetterTargetArn":sys.argv[1],"maxReceiveCount":"5"}))' "$DLQ_ARN")"
ATTRIBUTES="$(python3 -c 'import json,sys; print(json.dumps({"RedrivePolicy":sys.argv[1]}))' "$REDRIVE")"
awslocal sqs set-queue-attributes --queue-url http://localhost:4566/000000000000/wager-transactions.fifo --attributes "$ATTRIBUTES"
awslocal sqs create-queue --queue-name wager-events.fifo --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'
