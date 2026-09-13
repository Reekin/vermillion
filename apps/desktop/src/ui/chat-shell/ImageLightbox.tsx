import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { writeClipboardImage } from "./clipboard.js";

export type ImageLightboxState = {
  src: string;
  alt: string;
};

export type ImageLightboxProps = {
  image?: ImageLightboxState;
  onClose: () => void;
  renderContextMenu?: (props: {
    x: number; y: number; onClose: () => void; onCopy: () => void;
  }) => ReactNode;
};

export const ImageLightbox = ({
  image,
  onClose,
  renderContextMenu
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
      if (event.key === "Escape" && !menu) {
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
          onContextMenu={renderContextMenu ? (event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY });
            setNotice(undefined);
          } : undefined}
        />
        {menu && renderContextMenu?.({
          ...menu,
          onClose: () => setMenu(undefined),
          onCopy: () => {
            void writeClipboardImage(image.src)
              .then(() => setNotice({ message: "图片已复制" }))
              .catch((error: unknown) => setNotice({
                message: `复制图片失败：${error instanceof Error ? error.message : String(error)}`,
                error: true
              }));
          }
        })}
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
