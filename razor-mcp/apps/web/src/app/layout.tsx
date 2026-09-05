import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '@/context/AuthContext';
import { ChatProvider } from '@/context/ChatContext';
import OnyxAssistant from '@/components/OnyxAssistant';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Razor-MCP Realtime Console',
  description:
    'Autonomous agentic commerce gateway — live-web product search with real images, login-isolated rooms, human vs agent accounts, BYOK Razorpay TEST mode, guardrailed spending and a live audit trail. No real funds move.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen font-sans">
        {/* AuthProvider owns the login JWT / room; ChatProvider owns
            sessionId/agentId + the shared send(). Both mounted globally so the
            OnyxAssistant widget, ChatPanel and ProductGrid submit through ONE path. */}
        <AuthProvider>
          <ChatProvider>
            {children}
            {/* Onyx onboarding widget, mounted globally per spec. */}
            <OnyxAssistant />
          </ChatProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
