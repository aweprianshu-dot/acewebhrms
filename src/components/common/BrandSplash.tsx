import React from 'react';
import { AceBrandMark } from './AceBrandMark';
import { useThemeMode } from '../../utils/themeUtils';

interface BrandSplashProps {
  message?: string;
}

export const BrandSplash: React.FC<BrandSplashProps> = ({
  message = 'Initializing ACE Web Experts Workspace...',
}) => {
  const { isLight } = useThemeMode();

  return (
    <div
      className={`min-h-screen flex items-center justify-center p-6 relative overflow-hidden select-none ${
        isLight ? 'bg-[#F4F6FA] text-[#18181B]' : 'bg-[#0B0D12] text-white'
      }`}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-80"
        style={{
          background: isLight
            ? 'radial-gradient(ellipse at 50% 45%, rgba(255,70,52,0.10), transparent 55%), linear-gradient(145deg,#F4F6FA 35%,#FFF2EE 100%)'
            : 'radial-gradient(ellipse at 50% 45%, rgba(255,70,52,0.16), transparent 48%), linear-gradient(145deg,#0B0D12 35%,#1B100F 100%)',
        }}
      />
      <div className="absolute -top-40 -left-32 w-[34rem] h-[34rem] rounded-full blur-3xl opacity-20" style={{ background: '#FF4634' }} />
      <div className="absolute -bottom-48 -right-32 w-[36rem] h-[36rem] rounded-full blur-3xl opacity-15" style={{ background: '#FF6A33' }} />
      <div className="relative z-10 flex flex-col items-center text-center max-w-md w-full">
        <div
          className={`w-full max-w-[330px] rounded-2xl border p-7 shadow-2xl ${
            isLight
              ? 'bg-white/95 border-[#D5DCE6] shadow-slate-900/10'
              : 'bg-[#151922]/90 border-[#FF6A33]/25 shadow-[#FF4634]/10'
          }`}
        >
          <div className="flex justify-center">
            <AceBrandMark size={40} showWordmark showSubtitle subtitleText="HRMS" />
          </div>
          <div className="mt-4 text-xs uppercase tracking-[.26em] text-[#FF6A33] font-semibold">
            Human Resource Management
          </div>
          <div className="mt-7 h-1.5 rounded-full bg-[#292D36] overflow-hidden">
            <div className="h-full w-1/2 rounded-full bg-gradient-to-r from-[#FF4634] to-[#FF6A33] ace-splash-bar" />
          </div>
          <p className="mt-4 text-xs text-[#A1A1AA]">{message}</p>
        </div>
      </div>
    </div>
  );
};
