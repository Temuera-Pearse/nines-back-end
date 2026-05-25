export function isSimulationMode(): boolean {
  return process.env.NINES_SIMULATION_MODE === 'true'
}

export function simulationModeStartupMessage(): string {
  return 'NINES_SIMULATION_MODE enabled: persistence and financial writes disabled.'
}
