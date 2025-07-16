// File: Domains/Entities/Horse.cs
namespace Nines.BackEnd.Domains.Entities
{
    public class Horse
    {
        public int HorseId { get; set; }
        public string Name { get; set; } = default!;

        /// <summary>
        /// The odds for this horse—can be recalculated on the entity if you like.
        /// </summary>
        public decimal Odds { get; set; }
        
        public List<RaceParticipant> RaceParticipations { get; set; } = new();

        /// <summary>
    /// Distance traveled in the current simulation (meters).
    /// </summary>
    public double DistanceTravelled { get; private set; }

        private static readonly Random _rng = new();

        /// <summary>
        /// Simulates this horse running for the given seconds.
        /// Updates <see cref="DistanceTravelled"/>.
        /// </summary>
        public void Run(double seconds)
        {
            // e.g. random speed between 8 and 12 m/s
            var speed = _rng.NextDouble() * (12.0 - 8.0) + 8.0;
            DistanceTravelled = speed * seconds;
        }
    }
}
