import type { LearningWorkbenchApi, PiDesktopApi } from "../contracts/ipc";

export {};

declare global {
  interface Window {
    piApp?: PiDesktopApi;
    learningWorkbench?: LearningWorkbenchApi;
  }
}
