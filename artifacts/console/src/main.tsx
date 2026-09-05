import { createRoot } from "react-dom/client";
import App from "./App";
import { clearLegacySessionCaches } from "@workspace/web-ui";

void clearLegacySessionCaches();
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
