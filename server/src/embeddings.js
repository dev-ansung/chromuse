// Local text embeddings (transformers.js running an ONNX model in-process). No network after the first model download.
// The model loads on first use and is then kept; a failed load is retried on the next call.
// `embed(texts)` resolves to one unit-length vector per text, so cosine similarity is a plain dot product.

export function createEmbedder({ model, dtype = "q8" }) {
  let loading;
  const load = () => {
    loading ??= import("@huggingface/transformers")
      .then((m) => m.pipeline("feature-extraction", model, { dtype }))
      .catch((err) => {
        loading = undefined;
        throw err;
      });
    return loading;
  };
  return {
    model,
    async embed(texts) {
      const extractor = await load();
      const out = await extractor(texts, { pooling: "mean", normalize: true });
      return out.tolist();
    },
  };
}

export const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
