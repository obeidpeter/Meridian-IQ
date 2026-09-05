import { createRoot } from "react-dom/client";
import { CalculatorRoot } from "./calculator-root";
import "./index.css";

document.getElementById("copyright-year")!.textContent = String(
  new Date().getFullYear(),
);
createRoot(document.getElementById("root")!).render(<CalculatorRoot />);
