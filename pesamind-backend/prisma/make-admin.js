// Usage: node prisma/make-admin.js someone@example.com
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: node prisma/make-admin.js <email>"); // eslint-disable-line no-console
    process.exit(1);
  }
  const user = await prisma.user.update({ where: { email }, data: { role: "admin" } });
  console.log(`${user.email} is now an admin.`); // eslint-disable-line no-console
}

main()
  .catch((e) => {
    console.error(e); // eslint-disable-line no-console
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
