import { trpc } from "@/providers/trpc";
import { useCallback } from "react";

const VECTOR_KEYS = [
  "embedding_provider",
  "embedding_api_url",
  "embedding_api_key",
  "embedding_model",
  "embedding_dimension",
  "embedding_index_mode",
  "embedding_similarity_threshold",
] as const;

const AGENT_KEYS = [
  "tiangong_hub_url",
  "agent_token",
  "heartbeat_interval",
  "auto_reconnect",
] as const;

export type VectorSettingKey = (typeof VECTOR_KEYS)[number];
export type AgentSettingKey = (typeof AGENT_KEYS)[number];

export function useSettings() {
  const utils = trpc.useUtils();

  const setMutation = trpc.setting.set.useMutation({
    onSuccess: () => {
      utils.setting.getByKey.invalidate();
    },
  });

  const setManyMutation = trpc.setting.setMany.useMutation({
    onSuccess: () => {
      utils.setting.getByKey.invalidate();
    },
  });

  const setSetting = useCallback(
    async (key: string, value: string, category?: string) => {
      await setMutation.mutateAsync({ key, value, category });
    },
    [setMutation]
  );

  const setMany = useCallback(
    async (items: Array<{ key: string; value: string; category?: string }>) => {
      await setManyMutation.mutateAsync(items);
    },
    [setManyMutation]
  );

  return {
    setSetting,
    setMany,
    isSetting: setMutation.isPending || setManyMutation.isPending,
  };
}

export function useSettingValue(key: string) {
  return trpc.setting.getByKey.useQuery(
    { key },
    { staleTime: 1000 * 30 }
  );
}

export function useVectorSettings() {
  const provider = useSettingValue("embedding_provider");
  const apiUrl = useSettingValue("embedding_api_url");
  const apiKey = useSettingValue("embedding_api_key");
  const model = useSettingValue("embedding_model");
  const dimension = useSettingValue("embedding_dimension");
  const indexMode = useSettingValue("embedding_index_mode");
  const similarityThreshold = useSettingValue("embedding_similarity_threshold");

  return {
    provider: provider.data?.value ?? "",
    apiUrl: apiUrl.data?.value ?? "",
    apiKey: apiKey.data?.value ?? "",
    model: model.data?.value ?? "",
    dimension: dimension.data?.value ?? "",
    indexMode: indexMode.data?.value ?? "",
    similarityThreshold: similarityThreshold.data?.value ?? "",
    isLoading:
      provider.isLoading ||
      apiUrl.isLoading ||
      apiKey.isLoading ||
      model.isLoading ||
      dimension.isLoading ||
      indexMode.isLoading ||
      similarityThreshold.isLoading,
  };
}

export function useAppearanceSettings() {
  const fontSize = useSettingValue("appearance_font_size");
  const codeFont = useSettingValue("appearance_code_font");

  return {
    fontSize: fontSize.data?.value ?? "14",
    codeFont: codeFont.data?.value ?? "JetBrains Mono",
    isLoading: fontSize.isLoading || codeFont.isLoading,
  };
}

export function useStorageSettings() {
  const documents = useSettingValue("storage_documents_size");
  const vectors = useSettingValue("storage_vectors_size");
  const backups = useSettingValue("storage_backups_size");

  return {
    documents: documents.data?.value ?? "",
    vectors: vectors.data?.value ?? "",
    backups: backups.data?.value ?? "",
    isLoading: documents.isLoading || vectors.isLoading || backups.isLoading,
  };
}

export function useAgentSettings() {
  const hubUrl = useSettingValue("tiangong_hub_url");
  const token = useSettingValue("agent_token");
  const heartbeat = useSettingValue("heartbeat_interval");
  const autoReconnect = useSettingValue("auto_reconnect");

  return {
    hubUrl: hubUrl.data?.value ?? "",
    token: token.data?.value ?? "",
    heartbeat: heartbeat.data?.value ?? "",
    autoReconnect: autoReconnect.data?.value ?? "true",
    isLoading:
      hubUrl.isLoading ||
      token.isLoading ||
      heartbeat.isLoading ||
      autoReconnect.isLoading,
  };
}
