import { useEffect, useState } from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";

const LOGIN_PATH = "/login";

export default function AuthGuard() {
  const navigate = useNavigate();
  const location = useLocation();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/me", { credentials: "include" });
        const data = await res.json();
        if (cancelled) return;

        if (!data.success || !data.user) {
          // 未登录，跳转到登录页
          if (location.pathname !== LOGIN_PATH) {
            navigate(LOGIN_PATH, { replace: true });
          }
        }
        setChecking(false);
      } catch {
        if (cancelled) return;
        if (location.pathname !== LOGIN_PATH) {
          navigate(LOGIN_PATH, { replace: true });
        }
        setChecking(false);
      }
    }

    // 如果已经在登录页，直接放行
    if (location.pathname === LOGIN_PATH) {
      setChecking(false);
      return;
    }

    checkAuth();
    return () => { cancelled = true; };
  }, [navigate, location.pathname]);

  if (checking && location.pathname !== LOGIN_PATH) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg-primary)' }}>
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      </div>
    );
  }

  return <Outlet />;
}
