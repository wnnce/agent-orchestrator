export const systemApi = {
  async checkReady(): Promise<boolean> {
    try {
      const res = await fetch("/readyz");
      return res.ok;
    } catch {
      return false;
    }
  },
};
