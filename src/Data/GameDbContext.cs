using Microsoft.EntityFrameworkCore;
using Nines.BackEnd.Domains.Entities;

namespace Nines.BackEnd.Data
{
    public class GameDbContext : DbContext
    {
        public GameDbContext(DbContextOptions<GameDbContext> options)
            : base(options) { }

        public DbSet<Horse>           Horses            { get; set; } = default!;
        public DbSet<Race>            Races             { get; set; } = default!;
        public DbSet<RaceParticipant> RaceParticipants  { get; set; } = default!;

        protected override void OnModelCreating(ModelBuilder model)
        {
            // composite key for the join table
            model.Entity<RaceParticipant>()
                 .HasKey(rp => new { rp.RaceId, rp.HorseId });

            model.Entity<RaceParticipant>()
                 .HasOne(rp => rp.Race)
                 .WithMany(r => r.Participants)
                 .HasForeignKey(rp => rp.RaceId);

            model.Entity<RaceParticipant>()
                 .HasOne(rp => rp.Horse)
                 .WithMany(h => h.RaceParticipations)
                 .HasForeignKey(rp => rp.HorseId);

            // store the enum as a string
            model.Entity<Race>()
                 .Property(r => r.Status)
                 .HasConversion<string>()
                 .HasMaxLength(20);
        }
    }
}
