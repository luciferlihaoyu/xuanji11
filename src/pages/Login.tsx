import { useState } from "react";
import { useNavigate } from "react-router";
import { Orbit } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/providers/trpc";

/** 固定星点布局（百分比坐标），避免每次渲染随机跳动 */
const STARFIELD = [
  { x: "7%",  y: "14%", size: 2, duration: 3.4, delay: 0 },
  { x: "15%", y: "68%", size: 1, duration: 4.1, delay: 0.6 },
  { x: "22%", y: "30%", size: 1, duration: 2.8, delay: 1.2 },
  { x: "31%", y: "82%", size: 2, duration: 3.8, delay: 0.3 },
  { x: "38%", y: "9%",  size: 1, duration: 4.6, delay: 1.8 },
  { x: "47%", y: "24%", size: 1, duration: 3.1, delay: 0.9 },
  { x: "55%", y: "74%", size: 2, duration: 4.3, delay: 1.5 },
  { x: "63%", y: "16%", size: 1, duration: 2.9, delay: 0.2 },
  { x: "71%", y: "58%", size: 1, duration: 3.7, delay: 1.0 },
  { x: "79%", y: "34%", size: 2, duration: 4.9, delay: 0.5 },
  { x: "86%", y: "78%", size: 1, duration: 3.3, delay: 1.4 },
  { x: "92%", y: "11%", size: 1, duration: 4.0, delay: 0.8 },
  { x: "12%", y: "45%", size: 1, duration: 3.6, delay: 2.0 },
  { x: "67%", y: "88%", size: 1, duration: 4.4, delay: 0.4 },
] as const;

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
      console.error("Login error:", err);
      setError("账号或密码错误");
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
      className="relative min-h-screen flex items-center justify-center overflow-hidden"
      style={{
        backgroundColor: "var(--bg-primary)",
        backgroundImage: "var(--nebula-gradient)",
      }}
    >
      {/* 网格背景 */}
      <div className="absolute inset-0 bg-grid" aria-hidden />

      {/* 星点 */}
      <div className="absolute inset-0" aria-hidden>
        {STARFIELD.map((star, i) => (
          <span
            key={i}
            className="absolute rounded-full"
            style={{
              left: star.x,
              top: star.y,
              width: star.size,
              height: star.size,
              backgroundColor: "var(--star-color)",
              animation: `twinkle ${star.duration}s ease-in-out ${star.delay}s infinite`,
            }}
          />
        ))}
      </div>

      <Card
        className="relative z-10 w-full max-w-sm mx-4 animate-scale-in"
        style={{
          background: "var(--bg-glass)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          borderColor: "var(--border-subtle)",
          boxShadow:
            "0 8px 32px rgba(0, 0, 0, 0.3), 0 0 32px var(--accent-cyan-dim)",
        }}
      >
        <CardHeader className="text-center space-y-3">
          {/* Logo */}
          <div className="flex items-center justify-center gap-2">
            <Orbit
              className="w-7 h-7"
              style={{
                color: "var(--accent-cyan)",
                filter: "drop-shadow(0 0 6px var(--accent-cyan-dim))",
              }}
            />
            <span className="text-lg font-bold tracking-widest text-gradient-cyan">
              璇玑智脑
            </span>
          </div>
          <CardTitle
            className="text-base font-normal"
            style={{ color: "var(--text-secondary)" }}
          >
            管理员登录
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">账号</Label>
              <Input
                id="username"
                type="text"
                placeholder="请输入管理员账号"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                placeholder="请输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>

            {error && (
              <div
                className="text-sm px-3 py-2 rounded-md"
                style={{
                  color: "var(--accent-rose)",
                  background: "rgba(255, 107, 129, 0.1)",
                  border: "1px solid rgba(255, 107, 129, 0.25)",
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
            >
              {loading ? "登录中..." : "登录"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p
        className="absolute bottom-6 text-[10px] tracking-[0.3em] uppercase select-none"
        style={{ color: "var(--text-dim)" }}
      >
        XuanJi Brain
      </p>
    </div>
  );
}
