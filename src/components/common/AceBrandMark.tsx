import React from 'react';
import aceLogo from '../../assets/images/ace-web-experts-logo.webp';

interface AceBrandMarkProps {
  size?: number;
  className?: string;
  showWordmark?: boolean;
  showSubtitle?: boolean;
  subtitleText?: string;
  /** Override wordmark color when placed over dark photo overlays (e.g. login hero panel) */
  forceLightWordmark?: boolean;
}

/**
 * Renders the crisp orange/coral ACE monogram cleanly cropped from ace-web-experts-logo.webp (210x48),
 * paired with high-contrast theme-aware typography so text stays pure white in dark mode and dark ink in light mode.
 */
export const AceBrandMark: React.FC<AceBrandMarkProps> = ({
  size = 34,
  className = '',
  showWordmark = true,
  showSubtitle = false,
  subtitleText = 'HRMS',
  forceLightWordmark = false,
}) => {
  const monogramWidth = Math.round(size * 1.66);
  const fullImgWidth = Math.round(size * 4.375);
  const titleSize = Math.max(12, Math.round(size * 0.42));
  const subtitleSize = Math.max(9, Math.round(size * 0.27));

  return (
    <span className={`inline-flex items-center gap-2.5 shrink-0 select-none ${className}`}>
      <span
        className="relative overflow-hidden shrink-0 inline-block"
        style={{ width: monogramWidth, height: size }}
        aria-hidden={showWordmark ? true : undefined}
      >
        <img
          src={aceLogo}
          alt={showWordmark ? '' : 'ACE Web Experts'}
          style={{
            height: size,
            width: fullImgWidth,
            maxWidth: 'none',
            objectFit: 'contain',
            objectPosition: 'left center',
            display: 'block',
          }}
        />
      </span>
      {showWordmark && (
        <span className="flex flex-col leading-none">
          <span
            className={`font-display font-extrabold tracking-tight whitespace-nowrap ${
              forceLightWordmark ? 'ace-on-accent text-white' : 'ace-logo-text'
            }`}
            style={{ fontSize: titleSize }}
          >
            ACE WEB EXPERTS
          </span>
          {showSubtitle && (
            <span
              className="font-semibold uppercase tracking-[0.22em] text-[#FF6A33] mt-0.5 whitespace-nowrap"
              style={{ fontSize: subtitleSize }}
            >
              {subtitleText}
            </span>
          )}
        </span>
      )}
    </span>
  );
};
