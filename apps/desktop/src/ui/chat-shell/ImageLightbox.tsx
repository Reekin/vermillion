import { useEffect, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { writeClipboardImage } from "./clipboard.js";

export type ImageLightboxState = {
  src: string;
  alt: string;
};

export type ImageLightboxProps = {
  image?: ImageLightboxState;
  onClose: () => void;
};

export const ImageLightbox = ({
  image,
  onClose
}: ImageLightboxProps): ReactElement | null => {
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [notice, setNotice] = useState<{ message: string; error?: boolean }>();

  useEffect(() => {
    setMenu(undefined);
    setNotice(undefined);
  }, [image?.src]);

  useEffect(() => {
    if (!image) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && menu) {
        setMenu(undefined);
      } else if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [image, menu, onClose]);

  if (!image) {
    return null;
  }

  const markup = (
    <div
      className="awb-lightbox"
      role="presentation"
      onClick={onClose}
    >
      <section
        className="awb-lightbox__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={image.alt}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="awb-lightbox__close"
          onClick={onClose}
          aria-label="Close image preview"
        >
          Close
        </button>
        <img
          className="awb-lightbox__image"
          src={image.src}
          alt={image.alt}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({
              x: Math.min(event.clientX, window.innerWidth - 152),
              y: Math.min(event.clientY, window.innerHeight - 44)
            });
            setNotice(undefined);
          }}
        />
        {menu && <div
          className="awb-lightbox__context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => {
            setMenu(undefined);
            void writeClipboardImage(image.src)
              .then(() => setNotice({ message: "图片已复制" }))
              .catch((error: unknown) => setNotice({
                message: `复制图片失败：${error instanceof Error ? error.message : String(error)}`,
                error: true
              }));
          }}>复制图片</button>
        </div>}
        {notice && <div
          className={`awb-lightbox__notice${notice.error ? " is-error" : ""}`}
          role="status"
        >{notice.message}</div>}
      </section>
    </div>
  );

  return typeof document === "undefined"
    ? markup
    : createPortal(markup, document.body);
};
