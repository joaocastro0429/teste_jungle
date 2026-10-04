import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
export {
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
};
export class Queues {
  readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    requestHandler: { requestTimeout: 10000 },
    maxAttempts: 2,
  });
  input = '';
  dlq = '';
  events = '';
  async initialize() {
    const prefix = process.env.QUEUE_PREFIX ?? '';
    if (!/^[a-zA-Z0-9_-]{0,40}$/.test(prefix)) throw new Error('INVALID_QUEUE_PREFIX');
    this.dlq = (
      await this.client.send(
        new CreateQueueCommand({
          QueueName: prefix + 'wager-transactions-dlq.fifo',
          Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
        }),
      )
    ).QueueUrl!;
    const attrs = await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: this.dlq, AttributeNames: ['QueueArn'] }),
    );
    this.input = (
      await this.client.send(
        new CreateQueueCommand({
          QueueName: prefix + 'wager-transactions.fifo',
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'false',
            VisibilityTimeout: '30',
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: attrs.Attributes!.QueueArn,
              maxReceiveCount: '5',
            }),
          },
        }),
      )
    ).QueueUrl!;
    this.events = (
      await this.client.send(
        new CreateQueueCommand({
          QueueName: prefix + 'wager-events.fifo',
          Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
        }),
      )
    ).QueueUrl!;
  }
  async ready() {
    if (!this.input) throw new Error('QUEUES_NOT_INITIALIZED');
    await Promise.all(
      [this.input, this.events, this.dlq].map((QueueUrl) =>
        this.client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] })),
      ),
    );
  }
  close() {
    this.client.destroy();
  }
}
