import type { FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface LoginValues {
  server: string;
  username: string;
  password: string;
  otp: string;
}

interface LoginViewProps {
  values: LoginValues;
  onChange: (values: LoginValues) => void;
  otpRequired: boolean;
  error: string;
  busy: boolean;
  onSubmit: () => void;
}

export function LoginView({ values, onChange, otpRequired, error, busy, onSubmit }: LoginViewProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  const text = (key: keyof LoginValues) => ({
    id: key,
    value: values[key],
    onChange: (event: { target: { value: string } }) =>
      onChange({ ...values, [key]: event.target.value }),
  });

  return (
    <main className="flex h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Tresor öffnen</CardTitle>
          <CardDescription>Mit deinem Pleasant-Passwort entsperren.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" autoComplete="off" onSubmit={submit}>
            <div className="grid gap-2">
              <Label htmlFor="server">Server</Label>
              <Input {...text("server")} spellCheck={false} required placeholder="https://vault.example:10001" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="username">Benutzername</Label>
              <Input {...text("username")} spellCheck={false} required />
            </div>
            {otpRequired ? (
              <div className="grid gap-2">
                <Label htmlFor="otp">Zwei-Faktor-Code</Label>
                <Input {...text("otp")} inputMode="numeric" autoComplete="one-time-code" />
              </div>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="password">Passwort</Label>
                <Input {...text("password")} type="password" />
              </div>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={busy}>
              Entsperren
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
