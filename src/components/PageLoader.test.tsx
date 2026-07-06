import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PageLoader from "./PageLoader";

describe("PageLoader", () => {
  it("renders the spinner and loading text", () => {
    // Given: the Suspense fallback component.
    const component = <PageLoader />;

    // When: it is rendered to static markup.
    const markup = renderToStaticMarkup(component);

    // Then: the loading text and spinner class are present.
    expect(markup).toContain("加载中...");
    expect(markup).toContain("animate-rotate");
  });
});
