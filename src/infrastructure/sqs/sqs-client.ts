import { SQSClient } from "@aws-sdk/client-sqs";
import type { AwsConfig } from "../config/app-config";

export function createSqsClient(aws: AwsConfig): SQSClient {
  return new SQSClient({
    endpoint: aws.endpoint,
    region: aws.region,
    credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey },
    maxAttempts: 3,
  });
}
