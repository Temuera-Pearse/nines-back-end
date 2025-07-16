// File: src/Domains/Entities/RaceParticipant.cs

namespace Nines.BackEnd.Domains.Entities
{
    public class RaceParticipant
    {
        // ◉ Composite PK: Race + Horse
        public int RaceId   { get; set; }   // FK → Races.RaceId
        public int HorseId  { get; set; }   // FK → Horses.HorseId

        // ◉ Per‐race data:
        public decimal? OddsAtStart       { get; set; }
        public int?     FinishPosition    { get; set; }
        public double?  FinishTimeSeconds { get; set; }

        // ◉ Navigation props
        public Race  Race  { get; set; } = default!;
        public Horse Horse { get; set; } = default!;
    }
}
