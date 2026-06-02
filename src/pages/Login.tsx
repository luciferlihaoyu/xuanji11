import { useState } from "react";
import { useNavigate } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/providers/trpc";

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: () => {
      navigate("/");
    },
    onError: (err) => {
      setError(err.message || "登录失败");
      setLoading(false);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!username.trim() || !password.trim()) {
      setError("请输入账号和密码");
      return;
    }
    setLoading(true);
    loginMutation.mutate({ username: username.trim(), password });
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{
        background: `radial-gradient(ellipse at center, var(--bg-deep) 0%, var(--bg-base) 100%)`,
      }}
    >
      <Card
        className="w-full max-w-sm border border-[var(--border-c)]"
        style={{ background: "var(--card-bg)", backdropFilter: "blur(10px)" }}
      >
        <CardHeader className="text-center space-y-3">
          {/* Logo */}
          <div className="flex items-center justify-center gap-2">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="3" />
              <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" opacity="0.7" />
              <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-60 12 12)" opacity="0.4" />
            </svg>
            <span
              className="text-lg font-bold tracking-widest"
              style={{ color: "var(--accent)" }}
            >
              璇玑智脑
            </span>
          </div>
          <CardTitle className="text-base font-normal" style={{ color: "var(--text-secondary)" }}>
            管理员登录
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username" style={{ color: "var(--text-secondary)" }}>
                账号
              </Label>
              <Input
                id="username"
                type="text"
                placeholder="请输入管理员账号"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="border-[var(--border-c)]"
                style={{ background: "var(--input-bg)", color: "var(--text-primary)" }}
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" style={{ color: "var(--text-secondary)" }}>
                密码
              </Label>
              <Input
                id="password"
                type="password"
                placeholder="请输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="border-[var(--border-c)]"
                style={{ background: "var(--input-bg)", color: "var(--text-primary)" }}
                autoComplete="current-password"
              />
            </div>

            {error && (
              <div
                className="text-sm px-3 py-2 rounded-md"
                style={{
                  color: "#ef4444",
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.2)",
                }}
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              className="w-full font-medium"
              size="lg"
              disabled={loading}
              style={{
                background: "var(--accent)",
                color: "#0a0f1e",
              }}
            >
              {loading ? "登录中..." : "登录"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
