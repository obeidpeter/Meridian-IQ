import { webAppViteConfig } from "@workspace/web-config";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CalculatorDocument } from "./src/calculator-document";

// The full config (PORT/BASE_PATH contract, SEC-02 frame-ancestors CSP,
// plugins, aliases) is shared by the five web apps — see lib/web-config.
export default webAppViteConfig(import.meta.dirname, {
  basePath: "/penalty-calculator/",
  port: 4200,
}).then((config) => {
  config.plugins ??= [];
  config.plugins.push({
    name: "calculator-document",
    transformIndexHtml(html) {
      const marker = "<!--calculator-document-->";
      if (!html.includes(marker))
        throw new Error("Calculator document marker is missing");
      return html.replace(
        marker,
        renderToStaticMarkup(createElement(CalculatorDocument)),
      );
    },
  });
  return config;
});
