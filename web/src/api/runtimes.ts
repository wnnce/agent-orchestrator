import type { RuntimeInfo } from "../types";
import { http } from "./http";

export const runtimesApi = {
  async list(includeInternal = false): Promise<RuntimeInfo[]> {
    const data = await http.get<{ runtimes?: RuntimeInfo[] }>("/runtimes", {
      includeInternal,
    });
    return data.runtimes ?? [];
  },
};
