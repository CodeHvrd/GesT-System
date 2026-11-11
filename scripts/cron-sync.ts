import { runFullFudoAndContableSync } from "../src/lib/scheduler";

async function main() {
  console.log("Iniciando sincronización programada Fudo + Contable...");
  const res = await runFullFudoAndContableSync({ daysBack: 10 });
  console.log("Resultado de la sincronización:", JSON.stringify(res, null, 2));
}

main().catch((err) => {
  console.error("Error en sincronización:", err);
  process.exit(1);
});
