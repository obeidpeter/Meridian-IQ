import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ClipboardCheck, ShieldCheck, Trophy, Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useGetMe } from "@workspace/api-client-react";

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data: me } = useGetMe();

  const links = [
    { href: "/", label: "Confirmations", icon: ClipboardCheck },
    { href: "/suppliers", label: "Suppliers", icon: ShieldCheck },
    { href: "/scoreboard", label: "Scoreboard", icon: Trophy },
  ];

  const NavLinks = () => (
    <nav className="flex flex-col gap-1 p-4">
      <div className="mb-5 px-2">
        <h2 className="text-lg font-bold text-primary">MeridianIQ</h2>
        <p className="text-xs text-muted-foreground truncate">
          {me ? "Buyer rails" : "Loading…"}
        </p>
      </div>
      {links.map((link) => {
        const Icon = link.icon;
        const isActive =
          location === link.href ||
          (link.href !== "/" && location.startsWith(link.href));
        return (
          <Link
            key={link.href}
            href={link.href}
            data-testid={`nav-${link.label.toLowerCase().replace(/\s+/g, "-")}`}
            className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
              isActive
                ? "bg-primary text-primary-foreground font-medium"
                : "text-foreground hover:bg-muted"
            }`}
          >
            <Icon className="w-5 h-5" />
            {link.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      <div className="md:hidden flex items-center justify-between p-4 border-b bg-card">
        <h1 className="font-bold text-lg text-primary">MeridianIQ</h1>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" data-testid="button-menu">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0">
            <NavLinks />
          </SheetContent>
        </Sheet>
      </div>

      <div className="hidden md:block w-64 border-r bg-card min-h-screen">
        <NavLinks />
      </div>

      <main className="flex-1 p-4 md:p-8 overflow-y-auto max-w-6xl mx-auto w-full">
        {children}
      </main>
    </div>
  );
}
