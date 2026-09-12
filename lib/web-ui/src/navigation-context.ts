import { createContext } from "react";
import type { ProtectedNavigation } from "./protected-navigation";

export const NavigationContext = createContext<ProtectedNavigation | null>(
  null,
);
