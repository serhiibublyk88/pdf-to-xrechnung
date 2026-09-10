import { ReviewWorkspace } from '@/components/review/review-workspace';

export default async function InvoiceReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ReviewWorkspace invoiceId={id} />;
}
