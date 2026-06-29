import { trpc } from "@/providers/trpc";

export function useIngestion() {
  const listQuery = trpc.ingestion.listJobs.useQuery(undefined, {
    refetchInterval: 3000,
  });

  return {
    jobs: listQuery.data ?? [],
    isLoading: listQuery.isLoading,
    refetch: listQuery.refetch,
  };
}

export function useIngestionJob(id: number) {
  return trpc.ingestion.getJobById.useQuery({ id }, { refetchInterval: 3000 });
}

export function useIngestionItems(jobId: number) {
  return trpc.ingestion.getItemsByJobId.useQuery(
    { jobId },
    { refetchInterval: 3000 }
  );
}
