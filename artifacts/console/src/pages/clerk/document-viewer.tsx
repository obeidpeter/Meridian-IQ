import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Maximize,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { imageDataUri } from "@/pages/clerk-shared";

export function DocumentViewer({
  pages,
  name,
  singleImage = false,
}: {
  pages: string[];
  name: string;
  singleImage?: boolean;
}) {
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const currentPage = Math.min(page, Math.max(0, pages.length - 1));
  const actions = [
    {
      label: "Previous page",
      icon: ChevronLeft,
      disabled: currentPage === 0,
      run: () => setPage(currentPage - 1),
    },
    {
      label: "Next page",
      icon: ChevronRight,
      disabled: currentPage >= pages.length - 1,
      run: () => setPage(currentPage + 1),
    },
    {
      label: "Zoom out",
      icon: ZoomOut,
      disabled: zoom <= 50,
      run: () => setZoom(zoom - 25),
    },
    {
      label: "Zoom in",
      icon: ZoomIn,
      disabled: zoom >= 300,
      run: () => setZoom(zoom + 25),
    },
    {
      label: "Rotate clockwise",
      icon: RotateCw,
      disabled: false,
      run: () => setRotation((rotation + 90) % 360),
    },
    {
      label: "Reset document view",
      icon: Maximize,
      disabled: zoom === 100 && rotation === 0,
      run: () => {
        setZoom(100);
        setRotation(0);
      },
    },
  ];

  if (pages.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No source pages are available for this document.
      </p>
    );
  }

  return (
    <div className="min-w-0 space-y-2" data-testid="document-viewer">
      <div
        className="flex flex-wrap items-center gap-1"
        role="group"
        aria-label="Document controls"
      >
        <TooltipProvider>
          {actions.map(({ label, icon: Icon, disabled, run }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 shrink-0"
                  aria-label={label}
                  disabled={disabled}
                  onClick={run}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </TooltipProvider>
      </div>
      <p className="text-xs tabular-nums text-muted-foreground" role="status">
        Page {currentPage + 1} of {pages.length} · {zoom}% · {rotation}°
      </p>
      <DocumentPage
        key={`${currentPage}-${pages.length}`}
        source={pages[currentPage]}
        alt={
          singleImage
            ? `Captured document for ${name}`
            : `Page ${currentPage + 1} of ${name}`
        }
        testId={
          singleImage
            ? "img-source-document"
            : `img-source-page-${currentPage + 1}`
        }
        zoom={zoom}
        rotation={rotation}
      />
    </div>
  );
}

function DocumentPage({
  source,
  alt,
  testId,
  zoom,
  rotation,
}: {
  source: string;
  alt: string;
  testId: string;
  zoom: number;
  rotation: number;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [ratio, setRatio] = useState(1);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = () => setWidth(Math.max(1, element.clientWidth - 16));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    viewport.current?.scrollTo?.({ top: 0, left: 0 });
  }, [rotation]);
  const sideways = rotation % 180 !== 0;
  const stageWidth = (width * zoom) / 100;
  const stageHeight = stageWidth * (sideways ? ratio : 1 / ratio);

  return (
    <div
      ref={viewport}
      className="h-[min(60vh,40rem)] min-h-64 overflow-auto overscroll-contain rounded-md border bg-muted/30 p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      tabIndex={0}
      role="region"
      aria-label="Document page"
      data-testid="document-viewport"
    >
      {failed ? (
        <div className="space-y-2 p-3" role="alert">
          <p className="text-sm">This source image could not be displayed.</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setFailed(false);
              setAttempt(attempt + 1);
            }}
          >
            Retry image
          </Button>
        </div>
      ) : (
        // Reserve the rotated bounds so zoomed corners remain reachable by scrolling.
        <div
          className="relative mx-auto"
          style={{ width: stageWidth, height: stageHeight }}
        >
          <img
            key={attempt}
            src={imageDataUri(source)}
            alt={alt}
            data-testid={testId}
            draggable={false}
            className="absolute left-1/2 top-1/2 max-w-none"
            style={{
              width: sideways ? stageHeight : stageWidth,
              height: sideways ? stageWidth : stageHeight,
              transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
            }}
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth && image.naturalHeight)
                setRatio(image.naturalWidth / image.naturalHeight);
            }}
            onError={() => setFailed(true)}
          />
        </div>
      )}
    </div>
  );
}
