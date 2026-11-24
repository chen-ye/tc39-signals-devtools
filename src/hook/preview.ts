import type { ValuePreview } from "../protocol/types.ts";
import {
  formatErrorMessage,
  serializePreview as serializeSharedPreview,
} from "../shared/preview.ts";

export function serializePreview(value: unknown): ValuePreview {
  return serializeSharedPreview(value);
}

export { formatErrorMessage };
