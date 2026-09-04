import { createRoot } from "react-dom/client";
import { lazyRoute } from "@workspace/web-ui";
const App = lazyRoute(() => import("./App"));
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
