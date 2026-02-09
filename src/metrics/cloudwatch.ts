import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch'
let cw: CloudWatchClient | null = null

export function initCloudWatch(): void {
  if (!process.env.CLOUDWATCH_NAMESPACE) return
  cw = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-east-1' })
}

export async function pushMetrics(
  metrics: Array<{ name: string; value: number }>,
): Promise<void> {
  if (!cw || !process.env.CLOUDWATCH_NAMESPACE) return
  const Namespace = process.env.CLOUDWATCH_NAMESPACE
  const MetricData = metrics.map((m) => ({
    MetricName: m.name,
    Value: m.value,
  }))
  try {
    await cw.send(new PutMetricDataCommand({ Namespace, MetricData }))
  } catch {
    // ignore errors
  }
}
