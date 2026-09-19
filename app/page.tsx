import Link from "next/link";

const links = [
  {
    title: "Gemini Live",
    description: "Real-time voice conversation with Gemini.",
    href: "/gemini-live",
    icon: "🎙️",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-50 px-6 py-12">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-10">
          <p className="mb-2 text-sm font-medium text-blue-600">
            AI Playground
          </p>

          <h1 className="text-4xl font-bold tracking-tight text-gray-900">
            Welcome 👋
          </h1>

          <p className="mt-3 max-w-xl text-gray-500">
            Explore and test different AI experiments and projects.
          </p>
        </div>

        {/* Navigation */}
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="group rounded-2xl border bg-white p-6 transition hover:-translate-y-1 hover:shadow-lg"
            >
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100 text-2xl">
                {link.icon}
              </div>

              <h2 className="text-lg font-semibold text-gray-900">
                {link.title}
              </h2>

              <p className="mt-2 text-sm leading-6 text-gray-500">
                {link.description}
              </p>

              <div className="mt-5 text-sm font-medium text-blue-600">
                Open →
              </div>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
