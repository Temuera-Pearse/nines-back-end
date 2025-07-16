// File: src/Services/RaceScheduler.cs
using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Nines.BackEnd.Services
{
    public class RaceScheduler : BackgroundService
    {
        private readonly IRaceService _raceService;
        private readonly ILogger<RaceScheduler> _logger;

        public RaceScheduler(IRaceService raceService,
                             ILogger<RaceScheduler> logger)
        {
            _raceService = raceService;
            _logger      = logger;
        }

        protected override async Task ExecuteAsync(CancellationToken token)
        {
            _logger.LogInformation("RaceScheduler starting up.");

            while (!token.IsCancellationRequested)
            {
                var now = DateTime.UtcNow;

                // Compute next :00 mark
                var next00 = new DateTime(
                    now.Year, now.Month, now.Day,
                    now.Hour, now.Minute, 0, DateTimeKind.Utc);
                if (now.Second > 0 || now.Millisecond > 0)
                    next00 = next00.AddMinutes(1);

                // Phase :00 → open bets
                await DelayUntil(next00, token);
                _logger.LogInformation("Phase :00 – Opening bets");
                await _raceService.OpenBetsAsync();

                // Phase :27 → close bets
                var t27 = next00.AddSeconds(27);
                await DelayUntil(t27, token);
                _logger.LogInformation("Phase :27 – Closing bets");
                await _raceService.CloseBetsAsync();

                // Phase :30 → start & simulate race
                var t30 = next00.AddSeconds(30);
                await DelayUntil(t30, token);
                _logger.LogInformation("Phase :30 – Starting race & simulating outcome");
                await _raceService.StartRaceAsync();

                // Phase :50 → announce winner
                var t50 = next00.AddSeconds(50);
                await DelayUntil(t50, token);
                _logger.LogInformation("Phase :50 – Announcing winner");
                await _raceService.EndRaceAsync();

                // Phase :59 → reset for next cycle
                var t59 = next00.AddSeconds(59);
                await DelayUntil(t59, token);
                _logger.LogInformation("Phase :59 – Resetting state");
                await _raceService.ResetRaceAsync();
            }
        }

        private static Task DelayUntil(DateTime target, CancellationToken token)
        {
            var delay = target - DateTime.UtcNow;
            return delay > TimeSpan.Zero
                ? Task.Delay(delay, token)
                : Task.CompletedTask;
        }
    }
}
